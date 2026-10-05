<?php
declare(strict_types=1);

$configPath = dirname(__DIR__, 2) . '/private/config.php';
$config = is_file($configPath) ? require $configPath : null;
if (!is_array($config) || empty($config['db_host']) || empty($config['db_name']) || empty($config['db_user'])) {
    http_response_code(503);
    exit('Calendar unavailable');
}

require_once dirname(__DIR__) . '/lib/calendar.php';

$token = strtolower(trim((string)($_GET['token'] ?? '')));
if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
    http_response_code(404);
    exit('Calendar not found');
}

try {
    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
        (string)$config['db_host'],
        (int)($config['db_port'] ?? 3306),
        (string)$config['db_name']
    );
    $pdo = new PDO($dsn, (string)$config['db_user'], (string)$config['db_pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);

    $stmt = $pdo->prepare("
        SELECT ct.id, ct.token, ct.scope, ct.workspace_id, ct.user_id, b.name workspace_name
        FROM calendar_tokens ct
        JOIN boards b ON b.id = ct.workspace_id
        LEFT JOIN users u ON u.id = ct.user_id
        WHERE ct.token = ?
          AND (ct.scope = 'workspace' OR (ct.scope = 'personal' AND u.status = 'active'))
        LIMIT 1
    ");
    $stmt->execute([$token]);
    $feed = $stmt->fetch();
    if (!$feed) {
        http_response_code(404);
        exit('Calendar not found');
    }

    $rows = prj_calendar_rows($pdo, $feed);
    $ics = prj_calendar_ics($config, $feed, $rows);

    $filename = preg_replace('/[^a-zA-Z0-9_-]+/', '-', strtolower((string)$feed['workspace_name'])) ?: 'prj';
    header('Content-Type: text/calendar; charset=utf-8');
    header('Content-Disposition: inline; filename="' . $filename . '.ics"');
    header('Cache-Control: no-cache, max-age=0');
    header('X-Content-Type-Options: nosniff');
    echo $ics;
} catch (Throwable $e) {
    error_log('[PRJ calendar] ' . $e->getMessage());
    http_response_code(503);
    exit('Calendar unavailable');
}
