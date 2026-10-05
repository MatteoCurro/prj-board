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

function prj_mail_html_document(string $title, string $body, string $preheader = ''): string {
    $safeTitle = htmlspecialchars($title, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safePreheader = htmlspecialchars($preheader, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">'
        . '<title>' . $safeTitle . '</title></head>'
        . '<body style="margin:0;padding:0;background:#10110f;color:#f5f6f0;font-family:Arial,Helvetica,sans-serif">'
        . ($safePreheader !== '' ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">' . $safePreheader . '</div>' : '')
        . '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#10110f">'
        . '<tr><td align="center" style="padding:32px 16px">'
        . '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:680px">'
        . '<tr><td style="padding:0 0 14px">'
        . '<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>'
        . '<td style="width:38px;height:38px;background:#b6174b;border-radius:11px;text-align:center;vertical-align:middle;color:#ffffff;font-size:19px;font-weight:800">P</td>'
        . '<td style="padding-left:11px"><div style="font-size:17px;line-height:1.1;font-weight:800;color:#f5f6f0">PRJ</div>'
        . '<div style="margin-top:3px;font-size:11px;line-height:1.2;color:#7f8779">Project workspace</div></td>'
        . '</tr></table></td></tr>'
        . '<tr><td style="background:#191b17;border:1px solid #32362e;border-radius:16px;padding:26px 24px">'
        . $body
        . '</td></tr>'
        . '<tr><td style="padding:16px 4px 0;text-align:center;font-size:11px;line-height:1.5;color:#6f776b">'
        . 'PRJ · notifiche automatiche del tuo workspace'
        . '</td></tr></table></td></tr></table></body></html>';
}

function prj_php_mail_send(array $config, string $to, string $subject, string $html, string $text = ''): array {
    if (!function_exists('mail')) {
        throw new RuntimeException('PHP mail() non disponibile.');
    }

    $to = trim($to);
    $from = trim((string)($config['mail_from'] ?? 'prj@curromatteo.it'));
    $fromName = trim((string)($config['mail_from_name'] ?? 'PRJ'));
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) throw new InvalidArgumentException('Destinatario email non valido.');
    if (!filter_var($from, FILTER_VALIDATE_EMAIL)) throw new InvalidArgumentException('Mittente email non valido.');

    if ($text === '') {
        $text = trim(html_entity_decode(strip_tags(str_replace(
            ['<br>', '<br/>', '<br />', '</p>', '</li>'],
            ["\n", "\n", "\n", "\n", "\n"],
            $html
        )), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    }

    $domain = preg_replace('/^.*@/', '', $from);
    $boundary = 'prj_' . bin2hex(random_bytes(12));
    $messageId = bin2hex(random_bytes(12)) . '@' . $domain;
    $headers = [
        'Date: ' . date(DATE_RFC2822),
        'From: ' . prj_mail_header($fromName) . ' <' . $from . '>',
        'Message-ID: <' . $messageId . '>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
        'Auto-Submitted: auto-generated',
        'X-Auto-Response-Suppress: All',
        'X-Mailer: PRJ Board',
    ];

    $plain = str_replace("\n", "\r\n", str_replace("\r", '', $text));
    $message = '--' . $boundary . "\r\n"
        . "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
        . $plain . "\r\n\r\n"
        . '--' . $boundary . "\r\n"
        . "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
        . $html . "\r\n\r\n"
        . '--' . $boundary . "--\r\n";

    $extra = '-f' . escapeshellarg($from);
    $ok = @mail($to, prj_mail_header($subject), $message, implode("\r\n", $headers), $extra);
    if (!$ok) throw new RuntimeException('Il trasporto PHP mail() ha rifiutato il messaggio.');

    return [
        'ok' => true,
        'accepted' => true,
        'delivery_confirmed' => false,
        'recipient' => $to,
        'transport' => 'php-mail',
        'message_id' => $messageId,
        'response' => 'mail() accepted by configured sendmail transport',
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
        return prj_php_mail_send($config, $to, $subject, $html, $text);
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
        $result = prj_php_mail_send($config, $to, $subject, $html, $text);
        $result['smtp_error'] = $smtpError;
        return $result;
    }

    throw new RuntimeException('Invio SMTP fallito: ' . ($smtpError ?: 'errore sconosciuto'));
}
