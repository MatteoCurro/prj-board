<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("CLI only\n");
}

date_default_timezone_set('Europe/Rome');

$root = dirname(__DIR__);
$configPath = dirname($root) . '/private/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "PRJ digest: config non trovato.\n");
    exit(2);
}

$config = require $configPath;
require_once $root . '/lib/mailer.php';
require_once $root . '/lib/digest.php';

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

    $site = $pdo->query("SELECT site_name FROM site_settings WHERE id = 1")->fetchColumn() ?: 'PRJ';
    $users = $pdo->query("
        SELECT id, username, display_name, notification_email, digest_frequency, digest_due_days
        FROM users
        WHERE status = 'active'
          AND digest_frequency IN ('daily', 'weekly')
          AND notification_email IS NOT NULL
          AND notification_email <> ''
        ORDER BY id
    ")->fetchAll();

    $sent = 0;
    $skipped = 0;
    $failed = 0;
    foreach ($users as $user) {
        $user['id'] = (int)$user['id'];
        $user['digest_due_days'] = (int)$user['digest_due_days'];

        if (!prj_digest_should_send($pdo, $user)) {
            $skipped++;
            continue;
        }

        $tasks = prj_digest_tasks($pdo, $user['id'], $user['digest_due_days']);
        if (!$tasks) {
            $skipped++;
            continue;
        }

        $recipient = (string)$user['notification_email'];
        $mail = prj_digest_render($user, $tasks, (string)($config['app_url'] ?? 'https://prj.curromatteo.it'), (string)$site);

        try {
            prj_send_mail($config, $recipient, $mail['subject'], $mail['html'], $mail['text']);
            prj_digest_record($pdo, $user['id'], 'digest', $recipient, 'sent', count($tasks));
            $sent++;
            echo "SENT user={$user['id']} tasks=" . count($tasks) . "\n";
        } catch (Throwable $e) {
            prj_digest_record($pdo, $user['id'], 'digest', $recipient, 'failed', count($tasks), $e->getMessage());
            $failed++;
            fwrite(STDERR, "FAILED user={$user['id']}: {$e->getMessage()}\n");
        }

        usleep(150000);
    }

    echo "PRJ digest complete: sent=$sent skipped=$skipped failed=$failed\n";
    exit($failed > 0 ? 1 : 0);
} catch (Throwable $e) {
    fwrite(STDERR, 'PRJ digest fatal: ' . $e->getMessage() . "\n");
    exit(2);
}
