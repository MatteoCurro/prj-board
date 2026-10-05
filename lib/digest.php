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
        SELECT c.id, c.title, c.due_date, c.priority, bc.name column_name, b.id workspace_id, b.name workspace_name
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
    $today = new DateTimeImmutable('today', new DateTimeZone('Europe/Rome'));
    $dueDays = max(1, min(30, (int)($user['digest_due_days'] ?? 3)));
    $windowEnd = $today->modify('+' . $dueDays . ' days');
    $overdueCount = 0;
    $urgentCount = 0;

    foreach ($tasks as $task) {
        $due = new DateTimeImmutable((string)$task['due_date'], new DateTimeZone('Europe/Rome'));
        if ($due < $today) $overdueCount++;
        if (($task['priority'] ?? 'normal') === 'urgent') $urgentCount++;
    }

    $subject = '[' . $siteName . '] ' . $count . ($count === 1 ? ' attività da gestire' : ' attività da gestire');
    $safeName = htmlspecialchars($name, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeSite = htmlspecialchars($siteName, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $safeUrl = htmlspecialchars(rtrim($appUrl, '/'), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $summary = $count . ($count === 1 ? ' attività assegnata' : ' attività assegnate')
        . ($overdueCount ? ' · ' . $overdueCount . ($overdueCount === 1 ? ' scaduta' : ' scadute') : '')
        . ($urgentCount ? ' · ' . $urgentCount . ($urgentCount === 1 ? ' urgente' : ' urgenti') : '');

    $rows = '';
    $plain = "Ciao $name,\n\n";
    $plain .= "Hai $summary. Il riepilogo include le attività aperte con scadenza fino al " . $windowEnd->format('d/m/Y') . ".\n\n";

    $priorityMap = [
        'low' => ['Bassa', '#8fa08a', '#242a22'],
        'normal' => ['Normale', '#b5bcaf', '#292d27'],
        'high' => ['Alta', '#ffd27e', '#3b311f'],
        'urgent' => ['Urgente', '#ff93a5', '#3a2026'],
    ];

    foreach ($tasks as $task) {
        $due = new DateTimeImmutable((string)$task['due_date'], new DateTimeZone('Europe/Rome'));
        $days = (int)$today->diff($due)->format('%r%a');
        if ($days < 0) $dueLabel = 'Scaduta da ' . abs($days) . (abs($days) === 1 ? ' giorno' : ' giorni');
        elseif ($days === 0) $dueLabel = 'Scade oggi';
        elseif ($days === 1) $dueLabel = 'Scade domani';
        else $dueLabel = 'Scade tra ' . $days . ' giorni';

        $priorityKey = (string)($task['priority'] ?? 'normal');
        [$priorityLabel, $priorityColor, $priorityBg] = $priorityMap[$priorityKey] ?? $priorityMap['normal'];
        $dueColor = $days < 0 ? '#ff93a5' : ($days <= 2 ? '#ffd27e' : '#a8afa0');

        $title = htmlspecialchars((string)$task['title'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $workspace = htmlspecialchars((string)$task['workspace_name'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $column = htmlspecialchars((string)$task['column_name'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $date = $due->format('d/m/Y');

        $rows .= '<tr><td style="padding:14px 0;border-bottom:1px solid #2d312a">'
            . '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>'
            . '<td style="vertical-align:top;padding-right:12px">'
            . '<div style="font-size:14px;line-height:1.4;font-weight:700;color:#f5f6f0">' . $title . '</div>'
            . '<div style="font-size:12px;line-height:1.45;color:#8f978a;margin-top:5px">' . $workspace . ' · ' . $column . '</div>'
            . '<div style="font-size:12px;line-height:1.45;color:' . $dueColor . ';margin-top:6px;font-weight:700">' . $dueLabel . ' · ' . $date . '</div>'
            . '</td>'
            . '<td align="right" style="vertical-align:top;white-space:nowrap">'
            . '<span style="display:inline-block;padding:5px 8px;border-radius:999px;background:' . $priorityBg . ';color:' . $priorityColor . ';font-size:10px;line-height:1;font-weight:700">' . $priorityLabel . '</span>'
            . '</td></tr></table></td></tr>';

        $plain .= '- ' . $task['title']
            . ' — ' . $task['workspace_name'] . ' / ' . $task['column_name']
            . ' — ' . $dueLabel . ' (' . $date . ')'
            . ' — Priorità ' . $priorityLabel . "\n";
    }

    $body = '<div style="font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:#db2b64;font-weight:800">' . $safeSite . '</div>'
        . '<h1 style="font-size:24px;line-height:1.2;margin:8px 0 6px;color:#f5f6f0">Ciao ' . $safeName . ', ecco cosa richiede attenzione</h1>'
        . '<p style="font-size:13px;line-height:1.6;color:#a8afa0;margin:0">Riepilogo delle attività assegnate a te, già scadute o con scadenza entro il <strong style="color:#d7dbd2">' . $windowEnd->format('d/m/Y') . '</strong>.</p>'
        . '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0 4px"><tr>'
        . '<td style="background:#20231e;border:1px solid #32362e;border-radius:12px;padding:13px 14px">'
        . '<div style="font-size:11px;color:#7f8779;text-transform:uppercase;letter-spacing:.08em">In sintesi</div>'
        . '<div style="font-size:15px;line-height:1.45;color:#f5f6f0;font-weight:700;margin-top:4px">' . htmlspecialchars($summary, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</div>'
        . '</td></tr></table>'
        . '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse">' . $rows . '</table>'
        . '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:22px"><tr><td style="border-radius:10px;background:#b6174b">'
        . '<a href="' . $safeUrl . '" style="display:inline-block;padding:11px 16px;color:#ffffff;text-decoration:none;font-size:12px;line-height:1;font-weight:800">Apri PRJ</a>'
        . '</td></tr></table>'
        . '<p style="font-size:11px;line-height:1.55;color:#747c70;margin:19px 0 0">Ricevi questo riepilogo perché hai attivato le notifiche nel tuo profilo. Da lì puoi cambiare frequenza, finestra delle scadenze e indirizzo di recapito.</p>';

    $plain .= "\nApri PRJ: " . rtrim($appUrl, '/') . "\n";
    $plain .= "Puoi modificare frequenza, finestra delle scadenze e indirizzo email dal tuo profilo PRJ.\n";

    $preheader = $summary . ' · scadenze fino al ' . $windowEnd->format('d/m/Y');
    return [
        'subject' => $subject,
        'html' => prj_mail_html_document($subject, $body, $preheader),
        'text' => $plain,
    ];
}

