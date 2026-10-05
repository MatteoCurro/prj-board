<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$configPath = dirname(__DIR__, 2) . '/private/config.php';

function reply(array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $status = 400): never {
    reply(['ok' => false, 'error' => $message], $status);
}

function jsonBody(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') return [];
    $data = json_decode($raw, true);
    if (!is_array($data)) fail('Richiesta non valida.');
    return $data;
}

function cleanText(mixed $value, int $max): string {
    $value = trim((string)$value);
    if (mb_strlen($value) > $max) $value = mb_substr($value, 0, $max);
    return $value;
}

function intId(mixed $value): int {
    $id = filter_var($value, FILTER_VALIDATE_INT);
    if (!$id || $id < 1) fail('Identificativo non valido.');
    return (int)$id;
}

function positionForIndex(int $index): int {
    return ($index + 1) * 1000;
}

$config = is_file($configPath) ? require $configPath : null;
$setupRequired = !is_array($config)
    || empty($config['db_host'])
    || empty($config['db_name'])
    || empty($config['db_user'])
    || !array_key_exists('db_pass', $config)
    || empty($config['app_password']);

$secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
session_name('prj_session');
session_set_cookie_params([
    'lifetime' => 60 * 60 * 24 * 14,
    'path' => '/',
    'secure' => $secure,
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_start();

$action = (string)($_GET['action'] ?? 'status');

if ($action === 'status') {
    reply([
        'ok' => true,
        'setup_required' => $setupRequired,
        'authenticated' => !$setupRequired && !empty($_SESSION['authenticated']),
        'version' => '0.1.0',
    ]);
}

if ($setupRequired) {
    fail('Configurazione server incompleta.', 503);
}

if ($action === 'login') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('Metodo non consentito.', 405);
    $body = jsonBody();
    $password = (string)($body['password'] ?? '');
    $expected = (string)$config['app_password'];

    if ($password === '' || !hash_equals($expected, $password)) {
        $_SESSION['login_failures'] = min(8, (int)($_SESSION['login_failures'] ?? 0) + 1);
        usleep(min(1200000, 180000 * $_SESSION['login_failures']));
        fail('Password non corretta.', 401);
    }

    session_regenerate_id(true);
    $_SESSION['authenticated'] = true;
    $_SESSION['login_failures'] = 0;
    reply(['ok' => true]);
}

if ($action === 'logout') {
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'] ?? '', (bool)$params['secure'], (bool)$params['httponly']);
    }
    session_destroy();
    reply(['ok' => true]);
}

if (empty($_SESSION['authenticated'])) {
    fail('Autenticazione richiesta.', 401);
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

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS boards (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL,
            position INT NOT NULL DEFAULT 1000,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS board_columns (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            board_id INT UNSIGNED NOT NULL,
            name VARCHAR(80) NOT NULL,
            position INT NOT NULL DEFAULT 1000,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_columns_board_position (board_id, position),
            CONSTRAINT fk_columns_board FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS cards (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            column_id INT UNSIGNED NOT NULL,
            title VARCHAR(180) NOT NULL,
            description TEXT NULL,
            label VARCHAR(24) NOT NULL DEFAULT '',
            due_date DATE NULL,
            position INT NOT NULL DEFAULT 1000,
            archived TINYINT(1) NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_cards_column_position (column_id, archived, position),
            KEY idx_cards_updated (updated_at),
            CONSTRAINT fk_cards_column FOREIGN KEY (column_id) REFERENCES board_columns(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $boardId = (int)$pdo->query("SELECT id FROM boards ORDER BY position, id LIMIT 1")->fetchColumn();
    if (!$boardId) {
        $pdo->beginTransaction();
        $pdo->prepare("INSERT INTO boards (name, position) VALUES (?, 1000)")->execute(['Progetti']);
        $boardId = (int)$pdo->lastInsertId();
        $seed = $pdo->prepare("INSERT INTO board_columns (board_id, name, position) VALUES (?, ?, ?)");
        foreach (['Da fare', 'In corso', 'In attesa', 'Fatto'] as $i => $name) {
            $seed->execute([$boardId, $name, positionForIndex($i)]);
        }
        $pdo->commit();
    }
} catch (Throwable $e) {
    error_log('[PRJ] DB bootstrap error: ' . $e->getMessage());
    fail('Database non disponibile. Verifica la configurazione.', 503);
}

function boardPayload(PDO $pdo, int $boardId): array {
    $stmt = $pdo->prepare("SELECT id, name FROM boards WHERE id = ?");
    $stmt->execute([$boardId]);
    $board = $stmt->fetch();
    if (!$board) fail('Board non trovata.', 404);

    $stmt = $pdo->prepare("SELECT id, board_id, name, position FROM board_columns WHERE board_id = ? ORDER BY position, id");
    $stmt->execute([$boardId]);
    $columns = $stmt->fetchAll();

    $cardsByColumn = [];
    if ($columns) {
        $columnIds = array_map(fn($c) => (int)$c['id'], $columns);
        $marks = implode(',', array_fill(0, count($columnIds), '?'));
        $stmt = $pdo->prepare("
            SELECT id, column_id, title, description, label, due_date, position, updated_at
            FROM cards
            WHERE archived = 0 AND column_id IN ($marks)
            ORDER BY column_id, position, id
        ");
        $stmt->execute($columnIds);
        foreach ($stmt->fetchAll() as $card) {
            $card['id'] = (int)$card['id'];
            $card['column_id'] = (int)$card['column_id'];
            $card['position'] = (int)$card['position'];
            $cardsByColumn[$card['column_id']][] = $card;
        }
    }

    foreach ($columns as &$column) {
        $column['id'] = (int)$column['id'];
        $column['board_id'] = (int)$column['board_id'];
        $column['position'] = (int)$column['position'];
        $column['cards'] = $cardsByColumn[$column['id']] ?? [];
    }
    unset($column);

    return [
        'id' => (int)$board['id'],
        'name' => $board['name'],
        'columns' => $columns,
    ];
}

try {
    switch ($action) {
        case 'board':
            reply(['ok' => true, 'board' => boardPayload($pdo, $boardId)]);

        case 'board:update': {
            $body = jsonBody();
            $name = cleanText($body['name'] ?? '', 100);
            if ($name === '') fail('Inserisci il nome della board.');
            $pdo->prepare("UPDATE boards SET name = ? WHERE id = ?")->execute([$name, $boardId]);
            reply(['ok' => true]);
        }

        case 'column:create': {
            $body = jsonBody();
            $name = cleanText($body['name'] ?? '', 80);
            if ($name === '') fail('Inserisci il nome della colonna.');
            $stmt = $pdo->prepare("SELECT COALESCE(MAX(position), 0) + 1000 FROM board_columns WHERE board_id = ?");
            $stmt->execute([$boardId]);
            $position = (int)$stmt->fetchColumn();
            $pdo->prepare("INSERT INTO board_columns (board_id, name, position) VALUES (?, ?, ?)")->execute([$boardId, $name, $position]);
            reply(['ok' => true, 'id' => (int)$pdo->lastInsertId()]);
        }

        case 'column:update': {
            $body = jsonBody();
            $id = intId($body['id'] ?? null);
            $name = cleanText($body['name'] ?? '', 80);
            if ($name === '') fail('Inserisci il nome della colonna.');
            $stmt = $pdo->prepare("UPDATE board_columns SET name = ? WHERE id = ? AND board_id = ?");
            $stmt->execute([$name, $id, $boardId]);
            if (!$stmt->rowCount()) {
                $check = $pdo->prepare("SELECT id FROM board_columns WHERE id = ? AND board_id = ?");
                $check->execute([$id, $boardId]);
                if (!$check->fetchColumn()) fail('Colonna non trovata.', 404);
            }
            reply(['ok' => true]);
        }

        case 'column:delete': {
            $body = jsonBody();
            $id = intId($body['id'] ?? null);
            $stmt = $pdo->prepare("DELETE FROM board_columns WHERE id = ? AND board_id = ?");
            $stmt->execute([$id, $boardId]);
            if (!$stmt->rowCount()) fail('Colonna non trovata.', 404);
            reply(['ok' => true]);
        }

        case 'column:reorder': {
            $body = jsonBody();
            $ids = $body['ids'] ?? [];
            if (!is_array($ids)) fail('Ordine non valido.');
            $currentStmt = $pdo->prepare("SELECT id FROM board_columns WHERE board_id = ? ORDER BY position, id");
            $currentStmt->execute([$boardId]);
            $current = array_map('intval', $currentStmt->fetchAll(PDO::FETCH_COLUMN));
            $incoming = array_values(array_unique(array_map('intval', $ids)));
            sort($current);
            $check = $incoming;
            sort($check);
            if ($current !== $check) fail('L’ordine delle colonne non corrisponde alla board.');

            $pdo->beginTransaction();
            $update = $pdo->prepare("UPDATE board_columns SET position = ? WHERE id = ? AND board_id = ?");
            foreach ($incoming as $i => $id) $update->execute([positionForIndex($i), $id, $boardId]);
            $pdo->commit();
            reply(['ok' => true]);
        }

        case 'card:create': {
            $body = jsonBody();
            $columnId = intId($body['column_id'] ?? null);
            $title = cleanText($body['title'] ?? '', 180);
            $description = cleanText($body['description'] ?? '', 10000);
            $label = cleanText($body['label'] ?? '', 24);
            $dueDate = !empty($body['due_date']) ? (string)$body['due_date'] : null;
            if ($title === '') fail('Inserisci il titolo della card.');
            if ($dueDate !== null && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $dueDate)) fail('Data non valida.');

            $stmt = $pdo->prepare("SELECT id FROM board_columns WHERE id = ? AND board_id = ?");
            $stmt->execute([$columnId, $boardId]);
            if (!$stmt->fetchColumn()) fail('Colonna non trovata.', 404);

            $stmt = $pdo->prepare("SELECT COALESCE(MAX(position), 0) + 1000 FROM cards WHERE column_id = ? AND archived = 0");
            $stmt->execute([$columnId]);
            $position = (int)$stmt->fetchColumn();

            $stmt = $pdo->prepare("INSERT INTO cards (column_id, title, description, label, due_date, position) VALUES (?, ?, ?, ?, ?, ?)");
            $stmt->execute([$columnId, $title, $description, $label, $dueDate, $position]);
            reply(['ok' => true, 'id' => (int)$pdo->lastInsertId()]);
        }

        case 'card:update': {
            $body = jsonBody();
            $id = intId($body['id'] ?? null);
            $title = cleanText($body['title'] ?? '', 180);
            $description = cleanText($body['description'] ?? '', 10000);
            $label = cleanText($body['label'] ?? '', 24);
            $dueDate = !empty($body['due_date']) ? (string)$body['due_date'] : null;
            if ($title === '') fail('Inserisci il titolo della card.');
            if ($dueDate !== null && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $dueDate)) fail('Data non valida.');

            $stmt = $pdo->prepare("
                UPDATE cards c
                JOIN board_columns bc ON bc.id = c.column_id
                SET c.title = ?, c.description = ?, c.label = ?, c.due_date = ?
                WHERE c.id = ? AND bc.board_id = ? AND c.archived = 0
            ");
            $stmt->execute([$title, $description, $label, $dueDate, $id, $boardId]);
            if (!$stmt->rowCount()) {
                $check = $pdo->prepare("SELECT c.id FROM cards c JOIN board_columns bc ON bc.id=c.column_id WHERE c.id=? AND bc.board_id=? AND c.archived=0");
                $check->execute([$id, $boardId]);
                if (!$check->fetchColumn()) fail('Card non trovata.', 404);
            }
            reply(['ok' => true]);
        }

        case 'card:archive': {
            $body = jsonBody();
            $id = intId($body['id'] ?? null);
            $stmt = $pdo->prepare("
                UPDATE cards c
                JOIN board_columns bc ON bc.id = c.column_id
                SET c.archived = 1
                WHERE c.id = ? AND bc.board_id = ? AND c.archived = 0
            ");
            $stmt->execute([$id, $boardId]);
            if (!$stmt->rowCount()) fail('Card non trovata.', 404);
            reply(['ok' => true]);
        }

        case 'card:move': {
            $body = jsonBody();
            $id = intId($body['id'] ?? null);
            $fromColumn = intId($body['from_column_id'] ?? null);
            $toColumn = intId($body['to_column_id'] ?? null);
            $newIndex = max(0, (int)($body['new_index'] ?? 0));

            $valid = $pdo->prepare("SELECT id FROM board_columns WHERE board_id = ? AND id IN (?, ?)");
            $valid->execute([$boardId, $fromColumn, $toColumn]);
            $validIds = array_map('intval', $valid->fetchAll(PDO::FETCH_COLUMN));
            if (!in_array($fromColumn, $validIds, true) || !in_array($toColumn, $validIds, true)) fail('Colonna non valida.');

            $cardStmt = $pdo->prepare("
                SELECT c.id, c.column_id
                FROM cards c JOIN board_columns bc ON bc.id=c.column_id
                WHERE c.id=? AND bc.board_id=? AND c.archived=0
            ");
            $cardStmt->execute([$id, $boardId]);
            $card = $cardStmt->fetch();
            if (!$card) fail('Card non trovata.', 404);

            $pdo->beginTransaction();
            $pdo->prepare("UPDATE cards SET column_id = ? WHERE id = ?")->execute([$toColumn, $id]);

            $targetStmt = $pdo->prepare("SELECT id FROM cards WHERE column_id = ? AND archived = 0 AND id <> ? ORDER BY position, id");
            $targetStmt->execute([$toColumn, $id]);
            $targetIds = array_map('intval', $targetStmt->fetchAll(PDO::FETCH_COLUMN));
            $newIndex = min($newIndex, count($targetIds));
            array_splice($targetIds, $newIndex, 0, [$id]);

            $update = $pdo->prepare("UPDATE cards SET position = ? WHERE id = ?");
            foreach ($targetIds as $i => $cardId) $update->execute([positionForIndex($i), $cardId]);

            if ($fromColumn !== $toColumn) {
                $sourceStmt = $pdo->prepare("SELECT id FROM cards WHERE column_id = ? AND archived = 0 ORDER BY position, id");
                $sourceStmt->execute([$fromColumn]);
                foreach (array_map('intval', $sourceStmt->fetchAll(PDO::FETCH_COLUMN)) as $i => $cardId) {
                    $update->execute([positionForIndex($i), $cardId]);
                }
            }

            $pdo->commit();
            reply(['ok' => true]);
        }

        default:
            fail('Azione non disponibile.', 404);
    }
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log('[PRJ] API error [' . $action . ']: ' . $e->getMessage());
    fail('Si è verificato un errore sul server.', 500);
}
