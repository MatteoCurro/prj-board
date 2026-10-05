<?php
declare(strict_types=1);

function prj_digest_display_name(array $user): string {
    $name = trim((string)($user['display_name'] ?? ''));
    return $name !== '' ? $name : '@' . (string)($user['username'] ?? 'utente');
}

function prj_digest_tasks(PDO $pdo, int $userId, int $dueDays): array {
    $dueDays = max(1, min(30, $dueDays));
    $maxDate = (new DateTimeImmutable('today', new DateTimeZone('Europe/Rome')))
        ->modify('+' . $dueDays . ' days')->format('Y-m-d');

    $stmt = $pdo->prepare("
        SELECT c.id, c.title, c.due_date, bc.name column_name, b.id workspace_id, b.name workspace_name
        FROM card_assignees ca
        JOIN cards c ON c.id = ca.card_id
        JOIN board_columns bc ON bc.id = c.column_id
        JOIN boards b ON b.id = bc.board_id
        WHERE ca.user_id = ?
          AND c.archived = 0
          AND c.completed = 0
          AND c.due_date IS NOT NULL
          AND c.due_date <= ?
        ORDER BY c.due_date, b.position, bc.position, c.position, c.id
    ");
    $stmt->execute([$userId, $maxDate]);
    return $stmt->fetchAll();
}

function prj_digest_last_success(PDO $pdo, int $userId): ?string {
    $stmt = $pdo->prepare("
        SELECT created_at
        FROM digest_logs
        WHERE user_id = ? AND kind = 'digest' AND status IN ('accepted', 'sent')
        ORDER BY id DESC
        LIMIT 1
    ");
    $stmt->execute([$userId]);
    $value = $stmt->fetchColumn();
    return $value ? (string)$value : null;
}

function prj_digest_should_send(PDO $pdo, array $user): bool {
    $frequency = (string)($user['digest_frequency'] ?? 'off');
    if (!in_array($frequency, ['daily', 'weekly'], true)) return false;

    $last = prj_digest_last_success($pdo, (int)$user['id']);
    if (!$last) return true;

    $tz = new DateTimeZone('Europe/Rome');
    $lastDate = new DateTimeImmutable($last, $tz);
    $today = new DateTimeImmutable('today', $tz);
    if ($frequency === 'daily') return $lastDate->format('Y-m-d') !== $today->format('Y-m-d');
    return $lastDate <= $today->modify('-7 days');
}

function prj_digest_record(PDO $pdo, int $userId, string $kind, string $recipient, string $status, int $taskCount, ?string $error = null): void {
    $stmt = $pdo->prepare("
        INSERT INTO digest_logs (user_id, kind, recipient, status, task_count, error_message)
        VALUES (?, ?, ?, ?, ?, ?)
    ");
    $stmt->execute([$userId, $kind, $recipient, $status, $taskCount, $error ? mb_substr($error, 0, 1000) : null]);
}

function prj_digest_render(array $user, array $tasks, string $appUrl, string $siteName = 'PRJ'): array {
    $name = prj_digest_display_name($user);
    $count = count($tasks);
    $subject = '[' . $siteName . '] ' . $count . ($count === 1 ? ' attività da tenere d’occhio' : ' attività da tenere d’occhio');
    $today = new DateTimeImmutable('today', new DateTimeZone('Europe/Rome'));

    $rows = '';
    $plain = "Ciao $name,\n\n";
    $plain .= "Ecco le attività assegnate a te scadute o in scadenza.\n\n";

    foreach ($tasks as $task) {
        $due = new DateTimeImmutable((string)$task['due_date'], new DateTimeZone('Europe/Rome'));
        $days = (int)$today->diff($due)->format('%r%a');
        if ($days < 0) $label = 'Scaduta da ' . abs($days) . (abs($days) === 1 ? ' giorno' : ' giorni');
        elseif ($days === 0) $label = 'Scade oggi';
        elseif ($days === 1) $label = 'Scade domani';
        else $label = 'Scade tra ' . $days . ' giorni';

        $title = htmlspecialchars((string)$task['title'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $workspace = htmlspecialchars((string)$task['workspace_name'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $column = htmlspecialchars((string)$task['column_name'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $date = $due->format('d/m/Y');

        $rows .= '<tr><td style="padding:12px 0;border-bottom:1px solid #34382f">'
            . '<div style="font-size:14px;font-weight:700;color:#f1f3ee">' . $title . '</div>'
            . '<div style="font-size:12px;color:#a9afa4;margin-top:4px">' . $workspace . ' · ' . $column . '</div>'
            . '<div style="font-size:12px;color:' . ($days < 0 ? '#ff93a5' : ($days <= 2 ? '#ffd27e' : '#a9afa4')) . ';margin-top:5px">' . $label . ' · ' . $date . '</div>'
            . '</td></tr>';

        $plain .= '- ' . $task['title'] . ' — ' . $task['workspace_name'] . ' / ' . $task['column_name'] . ' — ' . $label . ' (' . $date . ")\n";
    }

    $safeName = htmlspecialchars($name, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeUrl = htmlspecialchars(rtrim($appUrl, '/'), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $body = '<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#d62b64;font-weight:700">' . htmlspecialchars($siteName, ENT_QUOTES, 'UTF-8') . '</div>'
        . '<h1 style="font-size:22px;margin:8px 0 6px;color:#f1f3ee">Ciao ' . $safeName . '</h1>'
        . '<p style="font-size:13px;line-height:1.55;color:#a9afa4;margin:0 0 14px">Hai ' . $count . ($count === 1 ? ' attività assegnata' : ' attività assegnate') . ' scadute o in scadenza.</p>'
        . '<table role="presentation" style="width:100%;border-collapse:collapse">' . $rows . '</table>'
        . '<p style="margin:20px 0 0"><a href="' . $safeUrl . '" style="display:inline-block;background:#b6174b;color:white;text-decoration:none;padding:10px 14px;border-radius:9px;font-size:12px;font-weight:700">Apri PRJ</a></p>'
        . '<p style="font-size:11px;color:#747a70;margin:18px 0 0">Puoi modificare frequenza e indirizzo email dal tuo profilo PRJ.</p>';

    $plain .= "\nApri PRJ: " . rtrim($appUrl, '/') . "\n";
    $plain .= "Puoi modificare frequenza e indirizzo email dal tuo profilo PRJ.\n";

    return ['subject' => $subject, 'html' => prj_mail_html_document($subject, $body), 'text' => $plain];
}
