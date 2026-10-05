<?php
declare(strict_types=1);

function prj_smtp_read($socket): array {
    $lines = [];
    $code = 0;
    while (($line = fgets($socket, 2048)) !== false) {
        $line = rtrim($line, "\r\n");
        $lines[] = $line;
        if (preg_match('/^(\d{3})([ -])/', $line, $m)) {
            $code = (int)$m[1];
            if ($m[2] === ' ') break;
        }
    }
    return ['code' => $code, 'text' => implode("\n", $lines)];
}

function prj_smtp_command($socket, string $command, array $expected): array {
    if ($command !== '') {
        fwrite($socket, $command . "\r\n");
    }
    $response = prj_smtp_read($socket);
    if (!in_array($response['code'], $expected, true)) {
        throw new RuntimeException('SMTP ' . ($response['code'] ?: '???') . ': ' . $response['text']);
    }
    return $response;
}

function prj_smtp_open(array $config) {
    $host = (string)($config['smtp_host'] ?? 'localhost');
    $port = (int)($config['smtp_port'] ?? 25);
    $timeout = (float)($config['smtp_timeout'] ?? 8);
    $errno = 0;
    $errstr = '';
    $socket = @fsockopen($host, $port, $errno, $errstr, $timeout);
    if (!$socket) {
        throw new RuntimeException("Connessione SMTP fallita ($errno): $errstr");
    }
    stream_set_timeout($socket, (int)ceil($timeout));
    prj_smtp_command($socket, '', [220]);
    $helo = preg_replace('/[^a-zA-Z0-9.-]/', '', (string)($config['smtp_helo'] ?? 'prj.curromatteo.it')) ?: 'localhost';
    prj_smtp_command($socket, 'EHLO ' . $helo, [250]);

    $user = trim((string)($config['smtp_user'] ?? ''));
    $pass = (string)($config['smtp_pass'] ?? '');
    if ($user !== '' || $pass !== '') {
        if ($user === '' || $pass === '') {
            throw new RuntimeException('Configurazione SMTP incompleta: username e password devono essere entrambi valorizzati.');
        }
        prj_smtp_command($socket, 'AUTH LOGIN', [334]);
        prj_smtp_command($socket, base64_encode($user), [334]);
        prj_smtp_command($socket, base64_encode($pass), [235]);
    }

    return $socket;
}

function prj_smtp_probe(array $config): array {
    $started = microtime(true);
    $socket = null;
    try {
        $socket = prj_smtp_open($config);
        try { prj_smtp_command($socket, 'QUIT', [221, 250]); } catch (Throwable) {}
        fclose($socket);
        return [
            'ok' => true,
            'host' => (string)($config['smtp_host'] ?? 'localhost'),
            'port' => (int)($config['smtp_port'] ?? 25),
            'ms' => (int)round((microtime(true) - $started) * 1000),
        ];
    } catch (Throwable $e) {
        if (is_resource($socket)) fclose($socket);
        return ['ok' => false, 'error' => $e->getMessage()];
    }
}

function prj_mail_header(string $value): string {
    $value = str_replace(["\r", "\n"], '', $value);
    if ($value === '') return '';
    return mb_encode_mimeheader($value, 'UTF-8', 'B', "\r\n");
}

function prj_mail_html_document(string $title, string $body): string {
    $safeTitle = htmlspecialchars($title, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
        . '<title>' . $safeTitle . '</title></head>'
        . '<body style="margin:0;background:#11120f;color:#ecefe8;font-family:Arial,sans-serif">'
        . '<div style="max-width:680px;margin:0 auto;padding:28px 18px">'
        . '<div style="background:#1a1d18;border:1px solid #353a31;border-radius:16px;padding:24px">'
        . $body
        . '</div><p style="color:#777d73;font-size:11px;text-align:center;margin:18px 0 0">PRJ · Project Board</p>'
        . '</div></body></html>';
}

function prj_smtp_local_diagnostic_send(array $config, string $to, string $subject, string $html, string $text = ''): array {
    $to = trim($to);
    $from = trim((string)($config['mail_from'] ?? 'prj@curromatteo.it'));
    $fromName = trim((string)($config['mail_from_name'] ?? 'PRJ'));
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) throw new InvalidArgumentException('Destinatario email non valido.');
    if (!filter_var($from, FILTER_VALIDATE_EMAIL)) throw new InvalidArgumentException('Mittente email non valido.');

    if ($text === '') {
        $text = trim(html_entity_decode(strip_tags(str_replace(['<br>', '<br/>', '<br />', '</p>', '</li>'], ["\n", "\n", "\n", "\n", "\n"], $html)), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    }

    $timeout = (float)($config['smtp_timeout'] ?? 8);
    $helo = preg_replace('/[^a-zA-Z0-9.-]/', '', (string)($config['smtp_helo'] ?? 'prj.curromatteo.it')) ?: 'prj.curromatteo.it';
    $transcript = [];
    $socket = null;
    $stage = 'connect';

    $record = static function (array &$transcript, string $step, array $response): void {
        $transcript[] = [
            'step' => $step,
            'code' => (int)($response['code'] ?? 0),
            'response' => (string)($response['text'] ?? ''),
        ];
    };

    $command = static function ($socket, string $step, string $command, array $expected, array &$transcript) use ($record): array {
        if ($command !== '') fwrite($socket, $command . "\r\n");
        $response = prj_smtp_read($socket);
        $record($transcript, $step, $response);
        if (!in_array($response['code'], $expected, true)) {
            throw new RuntimeException('SMTP ' . ($response['code'] ?: '???') . ' in fase ' . $step . ': ' . $response['text']);
        }
        return $response;
    };

    try {
        $errno = 0;
        $errstr = '';
        $socket = @fsockopen('localhost', 25, $errno, $errstr, $timeout);
        if (!$socket) throw new RuntimeException("Connessione al relay locale fallita ($errno): $errstr");
        stream_set_timeout($socket, (int)ceil($timeout));

        $banner = prj_smtp_read($socket);
        $record($transcript, 'CONNECT', $banner);
        if ($banner['code'] !== 220) throw new RuntimeException('SMTP ' . ($banner['code'] ?: '???') . ' in fase CONNECT: ' . $banner['text']);

        $stage = 'EHLO';
        $command($socket, 'EHLO', 'EHLO ' . $helo, [250], $transcript);
        $stage = 'MAIL FROM';
        $command($socket, 'MAIL FROM', 'MAIL FROM:<' . $from . '>', [250], $transcript);
        $stage = 'RCPT TO';
        $command($socket, 'RCPT TO', 'RCPT TO:<' . $to . '>', [250, 251], $transcript);
        $stage = 'DATA';
        $command($socket, 'DATA', 'DATA', [354], $transcript);

        $boundary = 'prj_diag_' . bin2hex(random_bytes(10));
        $headers = [
            'Date: ' . date(DATE_RFC2822),
            'From: ' . prj_mail_header($fromName) . ' <' . $from . '>',
            'To: <' . $to . '>',
            'Subject: ' . prj_mail_header($subject),
            'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . preg_replace('/^.*@/', '', $from) . '>',
            'MIME-Version: 1.0',
            'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
            'X-Mailer: PRJ Board Relay Diagnostic',
        ];
        $message = implode("\r\n", $headers) . "\r\n\r\n"
            . '--' . $boundary . "\r\n"
            . "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
            . str_replace("\n", "\r\n", str_replace("\r", '', $text)) . "\r\n\r\n"
            . '--' . $boundary . "\r\n"
            . "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
            . $html . "\r\n\r\n"
            . '--' . $boundary . "--\r\n";
        $message = preg_replace('/(?m)^\./', '..', $message);

        $stage = 'QUEUE';
        fwrite($socket, $message . "\r\n.\r\n");
        $queued = prj_smtp_read($socket);
        $record($transcript, 'QUEUE', $queued);
        if ($queued['code'] !== 250) {
            throw new RuntimeException('SMTP ' . ($queued['code'] ?: '???') . ' in fase QUEUE: ' . $queued['text']);
        }

        try { $command($socket, 'QUIT', 'QUIT', [221, 250], $transcript); } catch (Throwable) {}
        fclose($socket);

        return [
            'ok' => true,
            'accepted' => true,
            'delivery_confirmed' => false,
            'recipient' => $to,
            'transport' => 'smtp-local-diagnostic',
            'relay' => 'localhost:25',
            'stage' => 'QUEUE',
            'response' => $queued['text'],
            'transcript' => $transcript,
        ];
    } catch (Throwable $e) {
        if (is_resource($socket)) {
            try { fwrite($socket, "QUIT\r\n"); } catch (Throwable) {}
            fclose($socket);
        }
        return [
            'ok' => false,
            'accepted' => false,
            'delivery_confirmed' => false,
            'recipient' => $to,
            'transport' => 'smtp-local-diagnostic',
            'relay' => 'localhost:25',
            'stage' => $stage,
            'response' => null,
            'error' => $e->getMessage(),
            'transcript' => $transcript,
        ];
    }
}

function prj_mail_runtime_diagnostic(): array {
    $sendmailPath = trim((string)ini_get('sendmail_path'));
    $binary = '';
    if ($sendmailPath !== '' && preg_match('/^\s*([^\s]+)/', $sendmailPath, $match)) {
        $binary = trim($match[1], "'\"");
    }
    $disabled = array_values(array_filter(array_map('trim', explode(',', (string)ini_get('disable_functions')))));
    return [
        'php_version' => PHP_VERSION,
        'sapi' => PHP_SAPI,
        'sendmail_path' => $sendmailPath,
        'sendmail_binary' => $binary,
        'sendmail_exists' => $binary !== '' ? file_exists($binary) : null,
        'sendmail_executable' => $binary !== '' ? is_executable($binary) : null,
        'smtp_ini' => (string)ini_get('SMTP'),
        'smtp_port_ini' => (string)ini_get('smtp_port'),
        'mail_log' => (string)ini_get('mail.log'),
        'mail_force_extra_parameters' => (string)ini_get('mail.force_extra_parameters'),
        'proc_open_available' => function_exists('proc_open') && !in_array('proc_open', $disabled, true),
        'exec_available' => function_exists('exec') && !in_array('exec', $disabled, true),
    ];
}

function prj_sendmail_verbose_diagnostic(array $config, string $to, string $subject, string $text): array {
    $runtime = prj_mail_runtime_diagnostic();
    $sendmailPath = trim((string)($runtime['sendmail_path'] ?? ''));
    if ($sendmailPath === '') {
        return ['attempted' => false, 'ok' => false, 'error' => 'sendmail_path vuoto.', 'runtime' => $runtime];
    }
    if (empty($runtime['proc_open_available'])) {
        return ['attempted' => false, 'ok' => false, 'error' => 'proc_open non disponibile.', 'runtime' => $runtime];
    }

    $from = trim((string)($config['mail_from'] ?? 'prj@curromatteo.it'));
    $fromName = trim((string)($config['mail_from_name'] ?? 'PRJ'));
    if (!filter_var($to, FILTER_VALIDATE_EMAIL) || !filter_var($from, FILTER_VALIDATE_EMAIL)) {
        return ['attempted' => false, 'ok' => false, 'error' => 'Indirizzo email non valido.', 'runtime' => $runtime];
    }

    $command = $sendmailPath . ' -v -f ' . escapeshellarg($from) . ' ' . escapeshellarg($to);
    $spec = [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];

    $process = @proc_open($command, $spec, $pipes);
    if (!is_resource($process)) {
        return ['attempted' => true, 'ok' => false, 'error' => 'Impossibile avviare sendmail_path.', 'runtime' => $runtime];
    }

    $messageId = bin2hex(random_bytes(12)) . '@' . preg_replace('/^.*@/', '', $from);
    $message = implode("\r\n", [
        'Date: ' . date(DATE_RFC2822),
        'From: ' . prj_mail_header($fromName) . ' <' . $from . '>',
        'To: <' . $to . '>',
        'Subject: ' . prj_mail_header($subject),
        'Message-ID: <' . $messageId . '>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        'X-Mailer: PRJ Board Sendmail Diagnostic',
        '',
        str_replace("\r", '', $text),
        '',
    ]);

    fwrite($pipes[0], $message);
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[2]);
    $exitCode = proc_close($process);

    $limit = static fn(string $value): string => mb_substr(trim($value), 0, 8000);
    return [
        'attempted' => true,
        'ok' => $exitCode === 0,
        'exit_code' => $exitCode,
        'command' => $sendmailPath . ' -v -f <sender> <recipient>',
        'stdout' => $limit((string)$stdout),
        'stderr' => $limit((string)$stderr),
        'message_id' => $messageId,
        'runtime' => $runtime,
    ];
}

function prj_php_mail_send(array $config, string $to, string $subject, string $html): array {
    if (!function_exists('mail')) {
        throw new RuntimeException('PHP mail() non disponibile.');
    }

    $from = trim((string)($config['mail_from'] ?? 'prj@curromatteo.it'));
    $fromName = trim((string)($config['mail_from_name'] ?? 'PRJ'));
    $headers = [
        'From: ' . prj_mail_header($fromName) . ' <' . $from . '>',
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        'X-Mailer: PRJ Board',
    ];

    $extra = '-f' . escapeshellarg($from);
    $ok = @mail($to, prj_mail_header($subject), $html, implode("\r\n", $headers), $extra);
    if (!$ok) throw new RuntimeException('Il trasporto PHP mail() ha rifiutato il messaggio.');
    return [
        'ok' => true,
        'accepted' => true,
        'delivery_confirmed' => false,
        'recipient' => $to,
        'transport' => 'php-mail',
        'response' => 'mail() accepted by local transport',
    ];
}

function prj_email_transport_probe(array $config): array {
    $preferred = strtolower(trim((string)($config['mail_transport'] ?? 'auto')));
    if (!in_array($preferred, ['auto', 'smtp', 'php-mail'], true)) {
        return ['ok' => false, 'transport' => 'none', 'smtp' => ['ok' => false, 'error' => 'Trasporto email non valido.']];
    }

    if ($preferred === 'php-mail') {
        return [
            'ok' => function_exists('mail'),
            'transport' => function_exists('mail') ? 'php-mail' : 'none',
            'smtp' => ['ok' => false, 'skipped' => true, 'error' => 'SMTP non selezionato: uso esplicito di PHP mail().'],
        ];
    }

    $smtp = prj_smtp_probe($config);
    if (!empty($smtp['ok'])) {
        return ['ok' => true, 'transport' => 'smtp', 'smtp' => $smtp];
    }
    if ($preferred === 'smtp') {
        return ['ok' => false, 'transport' => 'smtp', 'smtp' => $smtp];
    }
    if (function_exists('mail')) {
        return ['ok' => true, 'transport' => 'php-mail', 'smtp' => $smtp];
    }
    return ['ok' => false, 'transport' => 'none', 'smtp' => $smtp];
}

function prj_send_mail(array $config, string $to, string $subject, string $html, string $text = ''): array {
    $to = trim($to);
    $from = trim((string)($config['mail_from'] ?? 'prj@curromatteo.it'));
    $fromName = trim((string)($config['mail_from_name'] ?? 'PRJ'));
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) throw new InvalidArgumentException('Destinatario email non valido.');
    if (!filter_var($from, FILTER_VALIDATE_EMAIL)) throw new InvalidArgumentException('Mittente email non valido.');

    if ($text === '') {
        $text = trim(html_entity_decode(strip_tags(str_replace(['<br>', '<br/>', '<br />', '</p>', '</li>'], ["\n", "\n", "\n", "\n", "\n"], $html)), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    }

    $preferred = strtolower(trim((string)($config['mail_transport'] ?? 'auto')));
    if (!in_array($preferred, ['auto', 'smtp', 'php-mail'], true)) {
        throw new RuntimeException('Trasporto email non valido: ' . $preferred);
    }
    if ($preferred === 'php-mail') {
        return prj_php_mail_send($config, $to, $subject, $html);
    }

    $socket = null;
    $smtpError = null;
    try {
        $socket = prj_smtp_open($config);
        prj_smtp_command($socket, 'MAIL FROM:<' . $from . '>', [250]);
        prj_smtp_command($socket, 'RCPT TO:<' . $to . '>', [250, 251]);
        prj_smtp_command($socket, 'DATA', [354]);

        $boundary = 'prj_' . bin2hex(random_bytes(12));
        $headers = [
            'Date: ' . date(DATE_RFC2822),
            'From: ' . prj_mail_header($fromName) . ' <' . $from . '>',
            'To: <' . $to . '>',
            'Subject: ' . prj_mail_header($subject),
            'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . preg_replace('/^.*@/', '', $from) . '>',
            'MIME-Version: 1.0',
            'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
            'X-Mailer: PRJ Board',
        ];

        $message = implode("\r\n", $headers) . "\r\n\r\n"
            . '--' . $boundary . "\r\n"
            . "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
            . str_replace("\n", "\r\n", str_replace("\r", '', $text)) . "\r\n\r\n"
            . '--' . $boundary . "\r\n"
            . "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
            . $html . "\r\n\r\n"
            . '--' . $boundary . "--\r\n";

        $message = preg_replace('/(?m)^\./', '..', $message);
        fwrite($socket, $message . "\r\n.\r\n");
        $accepted = prj_smtp_read($socket);
        if ($accepted['code'] !== 250) {
            throw new RuntimeException('SMTP ' . ($accepted['code'] ?: '???') . ': ' . $accepted['text']);
        }
        try { prj_smtp_command($socket, 'QUIT', [221, 250]); } catch (Throwable) {}
        fclose($socket);

        return [
            'ok' => true,
            'accepted' => true,
            'delivery_confirmed' => false,
            'recipient' => $to,
            'transport' => 'smtp',
            'response' => $accepted['text'],
        ];
    } catch (Throwable $e) {
        $smtpError = $e->getMessage();
        if (is_resource($socket)) fclose($socket);
    }

    if ($preferred === 'auto' && ($config['mail_fallback_php'] ?? true) && function_exists('mail')) {
        $result = prj_php_mail_send($config, $to, $subject, $html);
        $result['smtp_error'] = $smtpError;
        return $result;
    }

    throw new RuntimeException('Invio SMTP fallito: ' . ($smtpError ?: 'errore sconosciuto'));
}
