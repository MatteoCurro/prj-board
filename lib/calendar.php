<?php
declare(strict_types=1);

function prj_calendar_escape(string $value): string {
    $value = str_replace("\\", "\\\\", $value);
    $value = str_replace(["\r\n", "\r", "\n"], "\\n", $value);
    return str_replace([",", ";"], ["\\,", "\\;"], $value);
}

function prj_calendar_token(): string {
    return bin2hex(random_bytes(32));
}

function prj_calendar_url(array $config, string $token): string {
    return rtrim((string)($config['app_url'] ?? 'https://prj.curromatteo.it'), '/') . '/api/calendar.php?token=' . rawurlencode($token);
}

function prj_calendar_rows(PDO $pdo, array $feed): array {
    $workspaceId = (int)$feed['workspace_id'];
    $scope = (string)$feed['scope'];

    if ($scope === 'personal') {
        $stmt = $pdo->prepare("
            SELECT c.id, c.title, c.description, c.due_date, c.updated_at,
                   bc.name column_name, b.name workspace_name
            FROM cards c
            JOIN board_columns bc ON bc.id = c.column_id
            JOIN boards b ON b.id = bc.board_id
            JOIN card_assignees ca ON ca.card_id = c.id
            WHERE bc.board_id = ?
              AND ca.user_id = ?
              AND c.archived = 0
              AND c.completed = 0
              AND c.due_date IS NOT NULL
            ORDER BY c.due_date, bc.position, c.position, c.id
        ");
        $stmt->execute([$workspaceId, (int)$feed['user_id']]);
        return $stmt->fetchAll();
    }

    $stmt = $pdo->prepare("
        SELECT c.id, c.title, c.description, c.due_date, c.updated_at,
               bc.name column_name, b.name workspace_name
        FROM cards c
        JOIN board_columns bc ON bc.id = c.column_id
        JOIN boards b ON b.id = bc.board_id
        WHERE bc.board_id = ?
          AND c.archived = 0
          AND c.completed = 0
          AND c.due_date IS NOT NULL
        ORDER BY c.due_date, bc.position, c.position, c.id
    ");
    $stmt->execute([$workspaceId]);
    return $stmt->fetchAll();
}

function prj_calendar_ics(array $config, array $feed, array $rows): string {
    $appUrl = rtrim((string)($config['app_url'] ?? 'https://prj.curromatteo.it'), '/');
    $calendarName = (string)$feed['workspace_name'];
    if ($feed['scope'] === 'personal') $calendarName .= ' · Le mie scadenze';
    else $calendarName .= ' · PRJ';

    $lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//PRJ Board//Calendar Feed//IT',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:' . prj_calendar_escape($calendarName),
        'X-WR-TIMEZONE:Europe/Rome',
        'REFRESH-INTERVAL;VALUE=DURATION:PT4H',
        'X-PUBLISHED-TTL:PT4H',
    ];

    $now = gmdate('Ymd\THis\Z');
    foreach ($rows as $row) {
        $due = new DateTimeImmutable((string)$row['due_date'], new DateTimeZone('Europe/Rome'));
        $end = $due->modify('+1 day');
        $description = trim((string)($row['description'] ?? ''));
        $meta = (string)$row['workspace_name'] . ' · ' . (string)$row['column_name'];
        if ($description !== '') $meta .= "\n\n" . mb_substr($description, 0, 1200);
        $meta .= "\n\n" . $appUrl;

        $updated = new DateTimeImmutable((string)$row['updated_at'], new DateTimeZone('Europe/Rome'));

        $lines[] = 'BEGIN:VEVENT';
        $lines[] = 'UID:prj-card-' . (int)$row['id'] . '@prj.curromatteo.it';
        $lines[] = 'DTSTAMP:' . $now;
        $lines[] = 'LAST-MODIFIED:' . $updated->setTimezone(new DateTimeZone('UTC'))->format('Ymd\THis\Z');
        $lines[] = 'DTSTART;VALUE=DATE:' . $due->format('Ymd');
        $lines[] = 'DTEND;VALUE=DATE:' . $end->format('Ymd');
        $lines[] = 'SUMMARY:' . prj_calendar_escape((string)$row['title']);
        $lines[] = 'DESCRIPTION:' . prj_calendar_escape($meta);
        $lines[] = 'STATUS:CONFIRMED';
        $lines[] = 'TRANSP:TRANSPARENT';
        $lines[] = 'END:VEVENT';
    }

    $lines[] = 'END:VCALENDAR';
    return implode("\r\n", $lines) . "\r\n";
}
