<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function auto_reply(array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function auto_fail(string $message, int $status = 400): never {
    auto_reply(['ok' => false, 'error' => $message], $status);
}
function auto_text(mixed $value, int $max): string {
    $value = trim((string)$value);
    return mb_strlen($value) > $max ? mb_substr($value, 0, $max) : $value;
}
function auto_body(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') return [];
    $data = json_decode($raw, true);
    if (!is_array($data)) auto_fail('Payload JSON non valido.');
    return $data;
}

$configPath = dirname(__DIR__, 2) . '/private/config.php';
$config = is_file($configPath) ? require $configPath : null;
if (!is_array($config) || empty($config['db_host']) || empty($config['db_name']) || empty($config['db_user'])) {
    auto_fail('Automazione non disponibile.', 503);
}

$automationKey = trim((string)($config['automation_key'] ?? ''));
if ($automationKey === '') auto_fail('Automazione non configurata.', 503);

$auth = trim((string)($_SERVER['HTTP_AUTHORIZATION'] ?? ''));
if (!preg_match('/^Bearer\s+(.+)$/i', $auth, $m) || !hash_equals($automationKey, trim($m[1]))) {
    auto_fail('Non autorizzato.', 401);
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

    // L'endpoint può essere chiamato anche prima che un utente apra PRJ dopo un deploy:
    // assicuriamo quindi qui le sole colonne necessarie all'integrazione.
    $hasColumn = static function (PDO $pdo, string $column): bool {
        $stmt = $pdo->prepare("
            SELECT 1 FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cards' AND COLUMN_NAME = ?
            LIMIT 1
        ");
        $stmt->execute([$column]);
        return (bool)$stmt->fetchColumn();
    };
    if (!$hasColumn($pdo, 'due_time')) $pdo->exec("ALTER TABLE cards ADD COLUMN due_time TIME NULL AFTER due_date");
    if (!$hasColumn($pdo, 'source')) $pdo->exec("ALTER TABLE cards ADD COLUMN source VARCHAR(24) NOT NULL DEFAULT 'manual' AFTER priority");
    if (!$hasColumn($pdo, 'source_external_id')) $pdo->exec("ALTER TABLE cards ADD COLUMN source_external_id VARCHAR(191) NULL AFTER source");
    if (!$hasColumn($pdo, 'source_url')) $pdo->exec("ALTER TABLE cards ADD COLUMN source_url VARCHAR(500) NULL AFTER source_external_id");
    if (!$hasColumn($pdo, 'automation_confidence')) $pdo->exec("ALTER TABLE cards ADD COLUMN automation_confidence DECIMAL(5,4) NULL AFTER source_url");

    $action = (string)($_GET['action'] ?? 'context');

    if ($action === 'context') {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') auto_fail('Metodo non consentito.', 405);
        $workspaceId = filter_var($_GET['workspace_id'] ?? null, FILTER_VALIDATE_INT);
        $params = [];
        $where = '';
        if ($workspaceId) {
            $where = ' WHERE b.id = ?';
            $params[] = (int)$workspaceId;
        }
        $stmt = $pdo->prepare("SELECT b.id, b.name FROM boards b{$where} ORDER BY b.position, b.id");
        $stmt->execute($params);
        $workspaces = $stmt->fetchAll();

        $colStmt = $pdo->prepare("
            SELECT bc.id, bc.name
            FROM board_columns bc
            WHERE bc.board_id = ?
            ORDER BY bc.position, bc.id
        ");
        $tagStmt = $pdo->prepare("
            SELECT t.id, t.name, t.color
            FROM column_tags ct
            JOIN workspace_tags t ON t.id = ct.tag_id
            WHERE ct.column_id = ?
            ORDER BY t.name, t.id
        ");
        foreach ($workspaces as &$workspace) {
            $workspace['id'] = (int)$workspace['id'];
            $colStmt->execute([$workspace['id']]);
            $columns = $colStmt->fetchAll();
            foreach ($columns as &$column) {
                $column['id'] = (int)$column['id'];
                $tagStmt->execute([$column['id']]);
                $column['tags'] = array_map(static fn(array $tag): array => [
                    'id' => (int)$tag['id'],
                    'name' => (string)$tag['name'],
                    'color' => (string)$tag['color'],
                ], $tagStmt->fetchAll());
            }
            unset($column);
            $workspace['columns'] = $columns;
        }
        unset($workspace);
        auto_reply(['ok' => true, 'workspaces' => $workspaces]);
    }

    if ($action !== 'upsert') auto_fail('Azione non disponibile.', 404);
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') auto_fail('Metodo non consentito.', 405);

    $body = auto_body();
    $workspaceId = filter_var($body['workspace_id'] ?? null, FILTER_VALIDATE_INT);
    $columnId = filter_var($body['column_id'] ?? null, FILTER_VALIDATE_INT);
    if (!$workspaceId || !$columnId) auto_fail('Workspace o colonna non validi.');

    $source = strtolower(auto_text($body['source'] ?? 'gmail', 24));
    if ($source === 'manual' || !preg_match('/^[a-z0-9_-]{2,24}$/', $source)) auto_fail('Sorgente non valida.');
    $externalId = auto_text($body['source_external_id'] ?? '', 191);
    if ($externalId === '') auto_fail('Identificatore esterno obbligatorio.');

    $title = auto_text($body['title'] ?? '', 180);
    $description = auto_text($body['description'] ?? '', 10000);
    if ($title === '') auto_fail('Titolo obbligatorio.');

    $dueDate = !empty($body['due_date']) ? (string)$body['due_date'] : null;
    $dueTime = !empty($body['due_time']) ? (string)$body['due_time'] : null;
    if ($dueDate !== null && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $dueDate)) auto_fail('Data non valida.');
    if ($dueTime !== null && !preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/', $dueTime)) auto_fail('Ora non valida.');
    if ($dueDate === null) $dueTime = null;
    if ($dueTime !== null && strlen($dueTime) === 5) $dueTime .= ':00';

    $priority = strtolower(auto_text($body['priority'] ?? 'normal', 16));
    if (!in_array($priority, ['low', 'normal', 'high', 'urgent'], true)) auto_fail('Priorità non valida.');

    $sourceUrl = auto_text($body['source_url'] ?? '', 500);
    if ($sourceUrl !== '' && !filter_var($sourceUrl, FILTER_VALIDATE_URL)) auto_fail('URL origine non valido.');
    $sourceUrl = $sourceUrl !== '' ? $sourceUrl : null;

    $confidence = $body['automation_confidence'] ?? null;
    if ($confidence !== null) {
        if (!is_numeric($confidence)) auto_fail('Confidenza non valida.');
        $confidence = (float)$confidence;
        if ($confidence < 0 || $confidence > 1) auto_fail('Confidenza fuori intervallo.');
    }

    $column = $pdo->prepare("
        SELECT bc.id
        FROM board_columns bc
        WHERE bc.id = ? AND bc.board_id = ?
        LIMIT 1
    ");
    $column->execute([(int)$columnId, (int)$workspaceId]);
    if (!$column->fetchColumn()) auto_fail('Colonna non appartenente al workspace.', 404);

    $existing = $pdo->prepare("
        SELECT c.id, c.archived
        FROM cards c
        JOIN board_columns bc ON bc.id = c.column_id
        WHERE bc.board_id = ?
          AND c.source = ?
          AND c.source_external_id = ?
        LIMIT 1
    ");
    $existing->execute([(int)$workspaceId, $source, $externalId]);
    $card = $existing->fetch();

    if ($card) {
        if (!empty($card['archived'])) {
            auto_reply(['ok' => true, 'id' => (int)$card['id'], 'created' => false, 'archived' => true]);
        }
        $stmt = $pdo->prepare("
            UPDATE cards
            SET column_id = ?, title = ?, description = ?, due_date = ?, due_time = ?,
                priority = ?, source_url = ?, automation_confidence = ?
            WHERE id = ?
        ");
        $stmt->execute([
            (int)$columnId, $title, $description ?: null, $dueDate, $dueTime,
            $priority, $sourceUrl, $confidence, (int)$card['id'],
        ]);
        auto_reply(['ok' => true, 'id' => (int)$card['id'], 'created' => false]);
    }

    $positionStmt = $pdo->prepare("SELECT COALESCE(MAX(position), 0) + 1000 FROM cards WHERE column_id = ? AND archived = 0");
    $positionStmt->execute([(int)$columnId]);
    $position = (int)$positionStmt->fetchColumn();

    $pdo->beginTransaction();
    $insert = $pdo->prepare("
        INSERT INTO cards (
            column_id, title, description, label, due_date, due_time, priority,
            source, source_external_id, source_url, automation_confidence, position
        ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)
    ");
    $insert->execute([
        (int)$columnId, $title, $description ?: null, $dueDate, $dueTime, $priority,
        $source, $externalId, $sourceUrl, $confidence, $position,
    ]);
    $cardId = (int)$pdo->lastInsertId();

    $assigneeUsername = auto_text($body['assignee_username'] ?? '', 32);
    if ($assigneeUsername !== '') {
        $assignee = $pdo->prepare("
            SELECT u.id
            FROM users u
            LEFT JOIN workspace_members wm
              ON wm.user_id = u.id AND wm.workspace_id = ?
            WHERE u.username = ?
              AND u.status = 'active'
              AND (wm.workspace_id IS NOT NULL OR u.is_admin = 1)
            LIMIT 1
        ");
        $assignee->execute([(int)$workspaceId, $assigneeUsername]);
        $userId = $assignee->fetchColumn();
        if ($userId) {
            $pdo->prepare("INSERT INTO card_assignees (card_id, user_id) VALUES (?, ?)")
                ->execute([$cardId, (int)$userId]);
        }
    }

    $pdo->commit();
    auto_reply(['ok' => true, 'id' => $cardId, 'created' => true]);
} catch (Throwable $e) {
    if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
    error_log('[PRJ automation] ' . $e->getMessage());
    auto_fail('Errore interno automazione.', 500);
}
