<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$configPath = dirname(__DIR__, 2) . '/private/config.php';
$privateRoot = dirname(__DIR__, 2) . '/private';
$uploadsRoot = $privateRoot . '/uploads';

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
function columnExists(PDO $pdo, string $table, string $column): bool {
    $stmt = $pdo->prepare("
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
        LIMIT 1
    ");
    $stmt->execute([$table, $column]);
    return (bool)$stmt->fetchColumn();
}
function validColor(string $value): string {
    return preg_match('/^#[0-9a-fA-F]{6}$/', $value) ? strtolower($value) : '#5b6255';
}
function siteSettings(PDO $pdo): array {
    $row = $pdo->query("SELECT site_name, logo_url, description FROM site_settings WHERE id = 1")->fetch();
    return [
        'name' => $row['site_name'] ?? 'PRJ',
        'logo_url' => $row['logo_url'] ?? null,
        'description' => $row['description'] ?? 'Project workspace',
    ];
}
function currentUser(PDO $pdo): ?array {
    $id = (int)($_SESSION['user_id'] ?? 0);
    if (!$id) return null;
    $stmt = $pdo->prepare("SELECT id, username, status, is_admin FROM users WHERE id = ? LIMIT 1");
    $stmt->execute([$id]);
    $user = $stmt->fetch();
    if (!$user || $user['status'] !== 'active') {
        unset($_SESSION['user_id']);
        return null;
    }
    $user['id'] = (int)$user['id'];
    $user['is_admin'] = (bool)$user['is_admin'];
    return $user;
}
function workspaceRole(PDO $pdo, array $user, int $workspaceId): ?string {
    if (!empty($user['is_admin'])) return 'admin';
    $stmt = $pdo->prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? LIMIT 1");
    $stmt->execute([$workspaceId, $user['id']]);
    $role = $stmt->fetchColumn();
    return $role ? (string)$role : null;
}
function requireWorkspaceRole(PDO $pdo, array $user, int $workspaceId, array $allowed): string {
    $role = workspaceRole($pdo, $user, $workspaceId);
    if (!$role || !in_array($role, $allowed, true)) fail('Non hai i permessi per questo workspace.', 403);
    return $role;
}
function workspaceList(PDO $pdo, array $user): array {
    if (!empty($user['is_admin'])) {
        $stmt = $pdo->query("
            SELECT b.id, b.name, b.logo_url, 'admin' role
            FROM boards b
            ORDER BY b.position, b.id
        ");
    } else {
        $stmt = $pdo->prepare("
            SELECT b.id, b.name, b.logo_url, wm.role
            FROM boards b
            JOIN workspace_members wm ON wm.workspace_id = b.id
            WHERE wm.user_id = ?
            ORDER BY b.position, b.id
        ");
        $stmt->execute([$user['id']]);
    }
    $rows = $stmt->fetchAll();
    foreach ($rows as &$row) $row['id'] = (int)$row['id'];
    unset($row);
    return $rows;
}
function syncColumnTags(PDO $pdo, int $workspaceId, int $columnId, array $tagIds): void {
    $tagIds = array_values(array_unique(array_filter(array_map('intval', $tagIds), fn($id) => $id > 0)));
    if ($tagIds) {
        $marks = implode(',', array_fill(0, count($tagIds), '?'));
        $params = array_merge([$workspaceId], $tagIds);
        $stmt = $pdo->prepare("SELECT id FROM workspace_tags WHERE workspace_id = ? AND id IN ($marks)");
        $stmt->execute($params);
        $valid = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
        sort($valid);
        $check = $tagIds;
        sort($check);
        if ($valid !== $check) fail('Uno o più tag non appartengono al workspace.');
    }
    $pdo->prepare("DELETE FROM column_tags WHERE column_id = ?")->execute([$columnId]);
    if ($tagIds) {
        $insert = $pdo->prepare("INSERT INTO column_tags (column_id, tag_id) VALUES (?, ?)");
        foreach ($tagIds as $tagId) $insert->execute([$columnId, $tagId]);
    }
}
function cardWorkspaceId(PDO $pdo, int $cardId): ?int {
    $stmt = $pdo->prepare("
        SELECT bc.board_id
        FROM cards c JOIN board_columns bc ON bc.id = c.column_id
        WHERE c.id = ?
        LIMIT 1
    ");
    $stmt->execute([$cardId]);
    $id = $stmt->fetchColumn();
    return $id ? (int)$id : null;
}
function safeAttachment(array $file): array {
    if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) fail('Caricamento allegato non riuscito.');
    $size = (int)($file['size'] ?? 0);
    if ($size < 1 || $size > 25 * 1024 * 1024) fail('Ogni allegato deve essere compreso tra 1 byte e 25 MB.');

    $original = basename((string)($file['name'] ?? 'file'));
    $ext = strtolower(pathinfo($original, PATHINFO_EXTENSION));
    $allowed = [
        'jpg' => ['image/jpeg'], 'jpeg' => ['image/jpeg'], 'png' => ['image/png'],
        'webp' => ['image/webp'], 'gif' => ['image/gif'], 'heic' => ['image/heic','image/heif','application/octet-stream'],
        'pdf' => ['application/pdf'], 'txt' => ['text/plain'], 'md' => ['text/plain'],
        'csv' => ['text/plain','text/csv','application/vnd.ms-excel'], 'json' => ['application/json','text/plain'],
        'docx' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/zip'],
        'xlsx' => ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/zip'],
        'pptx' => ['application/vnd.openxmlformats-officedocument.presentationml.presentation','application/zip'],
        'odt' => ['application/vnd.oasis.opendocument.text','application/zip'],
        'ods' => ['application/vnd.oasis.opendocument.spreadsheet','application/zip'],
        'odp' => ['application/vnd.oasis.opendocument.presentation','application/zip'],
        'mp4' => ['video/mp4'], 'webm' => ['video/webm','audio/webm'], 'mp3' => ['audio/mpeg'],
        'wav' => ['audio/wav','audio/x-wav'], 'mov' => ['video/quicktime'],
    ];
    if (!isset($allowed[$ext])) fail('Tipo di allegato non consentito.');

    $tmp = (string)($file['tmp_name'] ?? '');
    if ($tmp === '' || !is_uploaded_file($tmp)) fail('Upload non valido.');
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mime = (string)$finfo->file($tmp);
    if (!in_array($mime, $allowed[$ext], true)) fail('Il contenuto del file non corrisponde al tipo dichiarato.');

    return [
        'tmp' => $tmp,
        'original' => mb_substr($original, 0, 240),
        'mime' => $mime,
        'size' => $size,
    ];
}
function workspacePayload(PDO $pdo, int $workspaceId, string $role): array {
    $stmt = $pdo->prepare("SELECT id, name, logo_url FROM boards WHERE id = ?");
    $stmt->execute([$workspaceId]);
    $workspace = $stmt->fetch();
    if (!$workspace) fail('Workspace non trovato.', 404);

    $tagsStmt = $pdo->prepare("SELECT id, name, color FROM workspace_tags WHERE workspace_id = ? ORDER BY name, id");
    $tagsStmt->execute([$workspaceId]);
    $tags = $tagsStmt->fetchAll();
    foreach ($tags as &$tag) $tag['id'] = (int)$tag['id'];
    unset($tag);

    $stmt = $pdo->prepare("
        SELECT id, board_id, name, color, position
        FROM board_columns
        WHERE board_id = ?
        ORDER BY position, id
    ");
    $stmt->execute([$workspaceId]);
    $columns = $stmt->fetchAll();

    $columnTags = [];
    $cardsByColumn = [];
    $attachmentsByCard = [];

    if ($columns) {
        $columnIds = array_map(fn($c) => (int)$c['id'], $columns);
        $marks = implode(',', array_fill(0, count($columnIds), '?'));

        $stmt = $pdo->prepare("
            SELECT ct.column_id, t.id, t.name, t.color
            FROM column_tags ct
            JOIN workspace_tags t ON t.id = ct.tag_id
            WHERE ct.column_id IN ($marks)
            ORDER BY t.name, t.id
        ");
        $stmt->execute($columnIds);
        foreach ($stmt->fetchAll() as $row) {
            $columnTags[(int)$row['column_id']][] = [
                'id' => (int)$row['id'],
                'name' => $row['name'],
                'color' => $row['color'],
            ];
        }

        $stmt = $pdo->prepare("
            SELECT id, column_id, title, description, label, due_date, position, updated_at
            FROM cards
            WHERE archived = 0 AND column_id IN ($marks)
            ORDER BY column_id, position, id
        ");
        $stmt->execute($columnIds);
        $cards = $stmt->fetchAll();

        if ($cards) {
            $cardIds = array_map(fn($c) => (int)$c['id'], $cards);
            $cardMarks = implode(',', array_fill(0, count($cardIds), '?'));
            $att = $pdo->prepare("
                SELECT id, card_id, original_name, mime_type, file_size, created_at
                FROM card_attachments
                WHERE card_id IN ($cardMarks)
                ORDER BY created_at, id
            ");
            $att->execute($cardIds);
            foreach ($att->fetchAll() as $a) {
                $attachmentsByCard[(int)$a['card_id']][] = [
                    'id' => (int)$a['id'],
                    'name' => $a['original_name'],
                    'mime' => $a['mime_type'],
                    'size' => (int)$a['file_size'],
                    'created_at' => $a['created_at'],
                ];
            }
        }

        foreach ($cards as $card) {
            $card['id'] = (int)$card['id'];
            $card['column_id'] = (int)$card['column_id'];
            $card['position'] = (int)$card['position'];
            $card['attachments'] = $attachmentsByCard[$card['id']] ?? [];
            $cardsByColumn[$card['column_id']][] = $card;
        }
    }

    foreach ($columns as &$column) {
        $column['id'] = (int)$column['id'];
        $column['board_id'] = (int)$column['board_id'];
        $column['position'] = (int)$column['position'];
        $column['tags'] = $columnTags[$column['id']] ?? [];
        $column['cards'] = $cardsByColumn[$column['id']] ?? [];
    }
    unset($column);

    return [
        'id' => (int)$workspace['id'],
        'name' => $workspace['name'],
        'logo_url' => $workspace['logo_url'],
        'role' => $role,
        'tags' => $tags,
        'columns' => $columns,
    ];
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

if ($setupRequired) {
    if ($action === 'status') {
        reply(['ok' => true, 'setup_required' => true, 'authenticated' => false, 'version' => '0.3.0']);
    }
    fail('Configurazione server incompleta.', 503);
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
    if (!columnExists($pdo, 'boards', 'logo_url')) {
        $pdo->exec("ALTER TABLE boards ADD COLUMN logo_url VARCHAR(500) NULL AFTER name");
    }

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
    if (!columnExists($pdo, 'board_columns', 'color')) {
        $pdo->exec("ALTER TABLE board_columns ADD COLUMN color VARCHAR(16) NOT NULL DEFAULT '#5b6255' AFTER name");
    }

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

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS users (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            username VARCHAR(32) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'pending',
            is_admin TINYINT(1) NOT NULL DEFAULT 0,
            approved_at DATETIME NULL,
            approved_by INT UNSIGNED NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_users_username (username),
            KEY idx_users_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS workspace_members (
            workspace_id INT UNSIGNED NOT NULL,
            user_id INT UNSIGNED NOT NULL,
            role VARCHAR(16) NOT NULL DEFAULT 'viewer',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (workspace_id, user_id),
            KEY idx_members_user (user_id),
            CONSTRAINT fk_members_workspace FOREIGN KEY (workspace_id) REFERENCES boards(id) ON DELETE CASCADE,
            CONSTRAINT fk_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS site_settings (
            id TINYINT UNSIGNED NOT NULL,
            site_name VARCHAR(100) NOT NULL DEFAULT 'PRJ',
            logo_url VARCHAR(500) NULL,
            description VARCHAR(255) NOT NULL DEFAULT 'Project workspace',
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");
    $pdo->exec("
        INSERT INTO site_settings (id, site_name, description)
        VALUES (1, 'PRJ', 'Project workspace')
        ON DUPLICATE KEY UPDATE id = id
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS workspace_tags (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            workspace_id INT UNSIGNED NOT NULL,
            name VARCHAR(40) NOT NULL,
            color VARCHAR(16) NOT NULL,
            created_by INT UNSIGNED NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_workspace_tag_name (workspace_id, name),
            KEY idx_workspace_tags_workspace (workspace_id),
            CONSTRAINT fk_tags_workspace FOREIGN KEY (workspace_id) REFERENCES boards(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS column_tags (
            column_id INT UNSIGNED NOT NULL,
            tag_id INT UNSIGNED NOT NULL,
            PRIMARY KEY (column_id, tag_id),
            KEY idx_column_tags_tag (tag_id),
            CONSTRAINT fk_column_tags_column FOREIGN KEY (column_id) REFERENCES board_columns(id) ON DELETE CASCADE,
            CONSTRAINT fk_column_tags_tag FOREIGN KEY (tag_id) REFERENCES workspace_tags(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS card_attachments (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            card_id INT UNSIGNED NOT NULL,
            original_name VARCHAR(240) NOT NULL,
            stored_name VARCHAR(80) NOT NULL,
            mime_type VARCHAR(120) NOT NULL,
            file_size INT UNSIGNED NOT NULL,
            created_by INT UNSIGNED NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_attachment_stored (stored_name),
            KEY idx_attachments_card (card_id),
            CONSTRAINT fk_attachments_card FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    if (!(int)$pdo->query("SELECT COUNT(*) FROM boards")->fetchColumn()) {
        $pdo->prepare("INSERT INTO boards (name, position) VALUES (?, 1000)")->execute(['Progetti']);
    }
    if (!is_dir($uploadsRoot) && !mkdir($uploadsRoot, 0700, true) && !is_dir($uploadsRoot)) {
        throw new RuntimeException('Impossibile creare la directory privata degli allegati.');
    }
} catch (Throwable $e) {
    error_log('[PRJ] DB bootstrap error: ' . $e->getMessage());
    fail('Database non disponibile. Verifica la configurazione.', 503);
}

if ($action === 'health') {
    reply([
        'ok' => true,
        'schema' => '0.3',
        'has_workspace' => (bool)$pdo->query("SELECT 1 FROM boards LIMIT 1")->fetchColumn(),
        'has_column' => (bool)$pdo->query("SELECT 1 FROM board_columns LIMIT 1")->fetchColumn(),
        'mail_available' => function_exists('mail'),
        'uploads_writable' => is_dir($uploadsRoot) && is_writable($uploadsRoot),
        'version' => '0.3.0',
    ]);
}

if ($action === 'status') {
    $user = currentUser($pdo);
    $site = siteSettings($pdo);
    if (!$user) {
        $a = random_int(2, 8);
        $b = random_int(1, 9);
        $_SESSION['register_challenge'] = $a + $b;
        $_SESSION['register_started_at'] = time();
        $adminExists = (bool)$pdo->query("SELECT 1 FROM users WHERE status='active' AND is_admin=1 LIMIT 1")->fetchColumn();
        reply([
            'ok' => true,
            'setup_required' => false,
            'authenticated' => false,
            'has_admin' => $adminExists,
            'challenge' => ['question' => "$a + $b"],
            'site' => $site,
            'version' => '0.3.0',
        ]);
    }

    reply([
        'ok' => true,
        'setup_required' => false,
        'authenticated' => true,
        'user' => $user,
        'workspaces' => workspaceList($pdo, $user),
        'site' => $site,
        'version' => '0.3.0',
    ]);
}

if ($action === 'register') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('Metodo non consentito.', 405);
    $body = jsonBody();

    if (cleanText($body['website'] ?? '', 100) !== '') fail('Registrazione non valida.');
    $started = (int)($_SESSION['register_started_at'] ?? 0);
    if (!$started || time() - $started < 1 || time() - $started > 3600) fail('Ricarica la pagina e riprova.');
    if ((int)($body['challenge_answer'] ?? -999) !== (int)($_SESSION['register_challenge'] ?? -998)) {
        fail('Verifica antispam non corretta.');
    }

    $username = strtolower(cleanText($body['username'] ?? '', 32));
    $password = (string)($body['password'] ?? '');
    $bootstrap = (string)($body['bootstrap_password'] ?? '');

    if (!preg_match('/^[a-z0-9._-]{3,32}$/', $username)) {
        fail('Username: usa 3–32 caratteri tra lettere, numeri, punto, trattino e underscore.');
    }
    if (strlen($password) < 8) fail('La password deve avere almeno 8 caratteri.');

    $exists = $pdo->prepare("SELECT 1 FROM users WHERE username = ? LIMIT 1");
    $exists->execute([$username]);
    if ($exists->fetchColumn()) fail('Username già utilizzato.', 409);

    $adminExists = (bool)$pdo->query("SELECT 1 FROM users WHERE status='active' AND is_admin=1 LIMIT 1")->fetchColumn();
    $becomeAdmin = !$adminExists && $bootstrap !== '' && hash_equals((string)$config['app_password'], $bootstrap);

    $stmt = $pdo->prepare("
        INSERT INTO users (username, password_hash, status, is_admin, approved_at)
        VALUES (?, ?, ?, ?, ?)
    ");
    $stmt->execute([
        $username,
        password_hash($password, PASSWORD_DEFAULT),
        $becomeAdmin ? 'active' : 'pending',
        $becomeAdmin ? 1 : 0,
        $becomeAdmin ? date('Y-m-d H:i:s') : null,
    ]);
    $userId = (int)$pdo->lastInsertId();

    if ($becomeAdmin) {
        $workspaceIds = $pdo->query("SELECT id FROM boards")->fetchAll(PDO::FETCH_COLUMN);
        $membership = $pdo->prepare("
            INSERT INTO workspace_members (workspace_id, user_id, role)
            VALUES (?, ?, 'admin')
            ON DUPLICATE KEY UPDATE role='admin'
        ");
        foreach ($workspaceIds as $workspaceId) $membership->execute([(int)$workspaceId, $userId]);
        session_regenerate_id(true);
        $_SESSION['user_id'] = $userId;
    }

    unset($_SESSION['register_challenge'], $_SESSION['register_started_at']);
    reply(['ok' => true, 'pending' => !$becomeAdmin, 'admin' => $becomeAdmin]);
}

if ($action === 'password:recover-admin') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('Metodo non consentito.', 405);
    $body = jsonBody();
    $username = strtolower(cleanText($body['username'] ?? '', 32));
    $newPassword = (string)($body['new_password'] ?? '');
    $appPassword = (string)($body['app_password'] ?? '');

    $_SESSION['recovery_attempts'] = min(10, (int)($_SESSION['recovery_attempts'] ?? 0) + 1);
    usleep(min(1500000, 180000 * $_SESSION['recovery_attempts']));

    if (strlen($newPassword) < 8) fail('La nuova password deve avere almeno 8 caratteri.');
    if ($appPassword === '' || !hash_equals((string)$config['app_password'], $appPassword)) {
        fail('Credenziali di recupero non valide.', 401);
    }

    $stmt = $pdo->prepare("SELECT id FROM users WHERE username = ? AND status='active' AND is_admin=1 LIMIT 1");
    $stmt->execute([$username]);
    $userId = (int)$stmt->fetchColumn();
    if (!$userId) fail('Account admin non trovato.', 404);

    $pdo->prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        ->execute([password_hash($newPassword, PASSWORD_DEFAULT), $userId]);

    $_SESSION['recovery_attempts'] = 0;
    reply(['ok' => true]);
}

if ($action === 'login') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('Metodo non consentito.', 405);
    $body = jsonBody();
    $username = strtolower(cleanText($body['username'] ?? '', 32));
    $password = (string)($body['password'] ?? '');

    $stmt = $pdo->prepare("SELECT id, password_hash, status FROM users WHERE username = ? LIMIT 1");
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if (!$user || !password_verify($password, $user['password_hash'])) {
        $_SESSION['login_failures'] = min(8, (int)($_SESSION['login_failures'] ?? 0) + 1);
        usleep(min(1200000, 180000 * $_SESSION['login_failures']));
        fail('Username o password non corretti.', 401);
    }
    if ($user['status'] === 'pending') fail('Account in attesa di approvazione.', 403);
    if ($user['status'] !== 'active') fail('Account non attivo.', 403);

    session_regenerate_id(true);
    $_SESSION['user_id'] = (int)$user['id'];
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

$user = currentUser($pdo);
if (!$user) fail('Autenticazione richiesta.', 401);

try {
    switch ($action) {
        case 'workspaces':
            reply(['ok' => true, 'workspaces' => workspaceList($pdo, $user)]);

        case 'workspace:get':
        case 'board': {
            $workspaceId = intId($_GET['workspace_id'] ?? $_GET['board_id'] ?? null);
            $role = requireWorkspaceRole($pdo, $user, $workspaceId, ['viewer', 'editor', 'admin']);
            reply(['ok' => true, 'workspace' => workspacePayload($pdo, $workspaceId, $role)]);
        }

        case 'workspace:create': {
            if (empty($user['is_admin'])) fail('Solo un admin globale può creare workspace.', 403);
            $body = jsonBody();
            $name = cleanText($body['name'] ?? '', 100);
            $logo = cleanText($body['logo_url'] ?? '', 500);
            if ($name === '') fail('Inserisci il nome del workspace.');
            if ($logo !== '' && !filter_var($logo, FILTER_VALIDATE_URL)) fail('URL del logo non valido.');

            $position = (int)$pdo->query("SELECT COALESCE(MAX(position), 0) + 1000 FROM boards")->fetchColumn();
            $pdo->prepare("INSERT INTO boards (name, logo_url, position) VALUES (?, ?, ?)")
                ->execute([$name, $logo ?: null, $position]);
            $id = (int)$pdo->lastInsertId();
            $pdo->prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'admin')")
                ->execute([$id, $user['id']]);
            reply(['ok' => true, 'id' => $id]);
        }

        case 'workspace:update':
        case 'board:update': {
            $body = jsonBody();
            $workspaceId = intId($body['workspace_id'] ?? $body['id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['admin']);
            $name = cleanText($body['name'] ?? '', 100);
            $logo = cleanText($body['logo_url'] ?? '', 500);
            if ($name === '') fail('Inserisci il nome del workspace.');
            if ($logo !== '' && !filter_var($logo, FILTER_VALIDATE_URL)) fail('URL del logo non valido.');
            $pdo->prepare("UPDATE boards SET name = ?, logo_url = ? WHERE id = ?")
                ->execute([$name, $logo ?: null, $workspaceId]);
            reply(['ok' => true]);
        }

        case 'tag:create':
        case 'tag:update': {
            $body = jsonBody();
            $workspaceId = intId($body['workspace_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['editor', 'admin']);
            $name = cleanText($body['name'] ?? '', 40);
            $color = validColor((string)($body['color'] ?? '#5b6255'));
            if ($name === '') fail('Inserisci il nome del tag.');
            if ($action === 'tag:create') {
                $stmt = $pdo->prepare("INSERT INTO workspace_tags (workspace_id, name, color, created_by) VALUES (?, ?, ?, ?)");
                try {
                    $stmt->execute([$workspaceId, $name, $color, $user['id']]);
                } catch (PDOException $e) {
                    if ((int)$e->errorInfo[1] === 1062) fail('Esiste già un tag con questo nome.', 409);
                    throw $e;
                }
                reply(['ok' => true, 'id' => (int)$pdo->lastInsertId()]);
            }
            $id = intId($body['id'] ?? null);
            $stmt = $pdo->prepare("UPDATE workspace_tags SET name = ?, color = ? WHERE id = ? AND workspace_id = ?");
            try {
                $stmt->execute([$name, $color, $id, $workspaceId]);
            } catch (PDOException $e) {
                if ((int)$e->errorInfo[1] === 1062) fail('Esiste già un tag con questo nome.', 409);
                throw $e;
            }
            reply(['ok' => true]);
        }

        case 'tag:delete': {
            $body = jsonBody();
            $workspaceId = intId($body['workspace_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['editor', 'admin']);
            $id = intId($body['id'] ?? null);
            $pdo->prepare("DELETE FROM workspace_tags WHERE id = ? AND workspace_id = ?")->execute([$id, $workspaceId]);
            reply(['ok' => true]);
        }

        case 'column:create': {
            $body = jsonBody();
            $workspaceId = intId($body['workspace_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['editor', 'admin']);
            $name = cleanText($body['name'] ?? '', 80);
            if ($name === '') fail('Inserisci il nome della colonna.');
            $positionStmt = $pdo->prepare("SELECT COALESCE(MAX(position), 0) + 1000 FROM board_columns WHERE board_id = ?");
            $positionStmt->execute([$workspaceId]);
            $position = (int)$positionStmt->fetchColumn();

            $pdo->beginTransaction();
            $pdo->prepare("INSERT INTO board_columns (board_id, name, color, position) VALUES (?, ?, '#5b6255', ?)")
                ->execute([$workspaceId, $name, $position]);
            $id = (int)$pdo->lastInsertId();
            syncColumnTags($pdo, $workspaceId, $id, is_array($body['tag_ids'] ?? null) ? $body['tag_ids'] : []);
            $pdo->commit();
            reply(['ok' => true, 'id' => $id]);
        }

        case 'column:update': {
            $body = jsonBody();
            $workspaceId = intId($body['workspace_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['editor', 'admin']);
            $id = intId($body['id'] ?? null);
            $name = cleanText($body['name'] ?? '', 80);
            if ($name === '') fail('Inserisci il nome della colonna.');

            $pdo->beginTransaction();
            $stmt = $pdo->prepare("UPDATE board_columns SET name = ? WHERE id = ? AND board_id = ?");
            $stmt->execute([$name, $id, $workspaceId]);
            syncColumnTags($pdo, $workspaceId, $id, is_array($body['tag_ids'] ?? null) ? $body['tag_ids'] : []);
            $pdo->commit();
            reply(['ok' => true]);
        }

        case 'column:delete': {
            $body = jsonBody();
            $workspaceId = intId($body['workspace_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['editor', 'admin']);
            $id = intId($body['id'] ?? null);
            $stmt = $pdo->prepare("DELETE FROM board_columns WHERE id = ? AND board_id = ?");
            $stmt->execute([$id, $workspaceId]);
            if (!$stmt->rowCount()) fail('Colonna non trovata.', 404);
            reply(['ok' => true]);
        }

        case 'column:reorder': {
            $body = jsonBody();
            $workspaceId = intId($body['workspace_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['editor', 'admin']);
            $ids = $body['ids'] ?? [];
            if (!is_array($ids)) fail('Ordine non valido.');

            $stmt = $pdo->prepare("SELECT id FROM board_columns WHERE board_id = ? ORDER BY position, id");
            $stmt->execute([$workspaceId]);
            $current = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
            $incoming = array_values(array_unique(array_map('intval', $ids)));
            $sortedCurrent = $current; sort($sortedCurrent);
            $sortedIncoming = $incoming; sort($sortedIncoming);
            if ($sortedCurrent !== $sortedIncoming) fail('L’ordine delle colonne non corrisponde al workspace.');

            $pdo->beginTransaction();
            $update = $pdo->prepare("UPDATE board_columns SET position = ? WHERE id = ? AND board_id = ?");
            foreach ($incoming as $i => $id) $update->execute([positionForIndex($i), $id, $workspaceId]);
            $pdo->commit();
            reply(['ok' => true]);
        }

        case 'card:create': {
            $body = jsonBody();
            $workspaceId = intId($body['workspace_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['editor', 'admin']);
            $columnId = intId($body['column_id'] ?? null);
            $title = cleanText($body['title'] ?? '', 180);
            $description = cleanText($body['description'] ?? '', 10000);
            $label = cleanText($body['label'] ?? '', 24);
            $dueDate = !empty($body['due_date']) ? (string)$body['due_date'] : null;
            if ($title === '') fail('Inserisci il titolo della card.');
            if ($dueDate !== null && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $dueDate)) fail('Data non valida.');

            $stmt = $pdo->prepare("SELECT id FROM board_columns WHERE id = ? AND board_id = ?");
            $stmt->execute([$columnId, $workspaceId]);
            if (!$stmt->fetchColumn()) fail('Colonna non trovata.', 404);

            $stmt = $pdo->prepare("SELECT COALESCE(MAX(position), 0) + 1000 FROM cards WHERE column_id = ? AND archived = 0");
            $stmt->execute([$columnId]);
            $position = (int)$stmt->fetchColumn();
            $pdo->prepare("
                INSERT INTO cards (column_id, title, description, label, due_date, position)
                VALUES (?, ?, ?, ?, ?, ?)
            ")->execute([$columnId, $title, $description, $label, $dueDate, $position]);
            reply(['ok' => true, 'id' => (int)$pdo->lastInsertId()]);
        }

        case 'card:update': {
            $body = jsonBody();
            $workspaceId = intId($body['workspace_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['editor', 'admin']);
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
            $stmt->execute([$title, $description, $label, $dueDate, $id, $workspaceId]);
            reply(['ok' => true]);
        }

        case 'card:archive': {
            $body = jsonBody();
            $workspaceId = intId($body['workspace_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['editor', 'admin']);
            $id = intId($body['id'] ?? null);
            $stmt = $pdo->prepare("
                UPDATE cards c
                JOIN board_columns bc ON bc.id = c.column_id
                SET c.archived = 1
                WHERE c.id = ? AND bc.board_id = ? AND c.archived = 0
            ");
            $stmt->execute([$id, $workspaceId]);
            if (!$stmt->rowCount()) fail('Card non trovata.', 404);
            reply(['ok' => true]);
        }

        case 'card:move': {
            $body = jsonBody();
            $workspaceId = intId($body['workspace_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['editor', 'admin']);
            $id = intId($body['id'] ?? null);
            $fromColumn = intId($body['from_column_id'] ?? null);
            $toColumn = intId($body['to_column_id'] ?? null);
            $newIndex = max(0, (int)($body['new_index'] ?? 0));

            $valid = $pdo->prepare("SELECT id FROM board_columns WHERE board_id = ? AND id IN (?, ?)");
            $valid->execute([$workspaceId, $fromColumn, $toColumn]);
            $validIds = array_map('intval', $valid->fetchAll(PDO::FETCH_COLUMN));
            if (!in_array($fromColumn, $validIds, true) || !in_array($toColumn, $validIds, true)) fail('Colonna non valida.');

            $stmt = $pdo->prepare("
                SELECT c.id
                FROM cards c JOIN board_columns bc ON bc.id = c.column_id
                WHERE c.id = ? AND bc.board_id = ? AND c.archived = 0
            ");
            $stmt->execute([$id, $workspaceId]);
            if (!$stmt->fetchColumn()) fail('Card non trovata.', 404);

            $pdo->beginTransaction();
            $pdo->prepare("UPDATE cards SET column_id = ? WHERE id = ?")->execute([$toColumn, $id]);

            $target = $pdo->prepare("
                SELECT id FROM cards
                WHERE column_id = ? AND archived = 0 AND id <> ?
                ORDER BY position, id
            ");
            $target->execute([$toColumn, $id]);
            $targetIds = array_map('intval', $target->fetchAll(PDO::FETCH_COLUMN));
            $newIndex = min($newIndex, count($targetIds));
            array_splice($targetIds, $newIndex, 0, [$id]);

            $update = $pdo->prepare("UPDATE cards SET position = ? WHERE id = ?");
            foreach ($targetIds as $i => $cardId) $update->execute([positionForIndex($i), $cardId]);

            if ($fromColumn !== $toColumn) {
                $source = $pdo->prepare("SELECT id FROM cards WHERE column_id = ? AND archived = 0 ORDER BY position, id");
                $source->execute([$fromColumn]);
                foreach (array_map('intval', $source->fetchAll(PDO::FETCH_COLUMN)) as $i => $cardId) {
                    $update->execute([positionForIndex($i), $cardId]);
                }
            }
            $pdo->commit();
            reply(['ok' => true]);
        }

        case 'attachment:upload': {
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('Metodo non consentito.', 405);
            $workspaceId = intId($_POST['workspace_id'] ?? null);
            $cardId = intId($_POST['card_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['editor', 'admin']);
            if (cardWorkspaceId($pdo, $cardId) !== $workspaceId) fail('Card non trovata.', 404);

            if (!isset($_FILES['files'])) fail('Nessun file ricevuto.');
            $raw = $_FILES['files'];
            $count = is_array($raw['name']) ? count($raw['name']) : 1;
            if ($count > 10) fail('Puoi caricare al massimo 10 file alla volta.');

            $files = [];
            for ($i = 0; $i < $count; $i++) {
                $file = [
                    'name' => is_array($raw['name']) ? $raw['name'][$i] : $raw['name'],
                    'type' => is_array($raw['type']) ? $raw['type'][$i] : $raw['type'],
                    'tmp_name' => is_array($raw['tmp_name']) ? $raw['tmp_name'][$i] : $raw['tmp_name'],
                    'error' => is_array($raw['error']) ? $raw['error'][$i] : $raw['error'],
                    'size' => is_array($raw['size']) ? $raw['size'][$i] : $raw['size'],
                ];
                $files[] = safeAttachment($file);
            }

            $insert = $pdo->prepare("
                INSERT INTO card_attachments
                    (card_id, original_name, stored_name, mime_type, file_size, created_by)
                VALUES (?, ?, ?, ?, ?, ?)
            ");
            $created = [];
            foreach ($files as $file) {
                $stored = bin2hex(random_bytes(24)) . '.bin';
                $dest = $uploadsRoot . '/' . $stored;
                if (!move_uploaded_file($file['tmp'], $dest)) fail('Impossibile salvare un allegato.', 500);
                @chmod($dest, 0600);
                try {
                    $insert->execute([$cardId, $file['original'], $stored, $file['mime'], $file['size'], $user['id']]);
                    $created[] = (int)$pdo->lastInsertId();
                } catch (Throwable $e) {
                    @unlink($dest);
                    throw $e;
                }
            }
            reply(['ok' => true, 'ids' => $created]);
        }

        case 'attachment:download': {
            $id = intId($_GET['id'] ?? null);
            $stmt = $pdo->prepare("
                SELECT a.*, bc.board_id
                FROM card_attachments a
                JOIN cards c ON c.id = a.card_id
                JOIN board_columns bc ON bc.id = c.column_id
                WHERE a.id = ?
                LIMIT 1
            ");
            $stmt->execute([$id]);
            $att = $stmt->fetch();
            if (!$att) fail('Allegato non trovato.', 404);
            requireWorkspaceRole($pdo, $user, (int)$att['board_id'], ['viewer', 'editor', 'admin']);
            $path = $uploadsRoot . '/' . basename($att['stored_name']);
            if (!is_file($path)) fail('File non disponibile.', 404);

            header_remove('Content-Type');
            header('Content-Type: application/octet-stream');
            header('Content-Length: ' . filesize($path));
            header("Content-Disposition: attachment; filename*=UTF-8''" . rawurlencode($att['original_name']));
            header('X-Content-Type-Options: nosniff');
            header('Cache-Control: private, no-store');
            readfile($path);
            exit;
        }

        case 'attachment:delete': {
            $body = jsonBody();
            $id = intId($body['id'] ?? null);
            $stmt = $pdo->prepare("
                SELECT a.stored_name, bc.board_id
                FROM card_attachments a
                JOIN cards c ON c.id = a.card_id
                JOIN board_columns bc ON bc.id = c.column_id
                WHERE a.id = ?
                LIMIT 1
            ");
            $stmt->execute([$id]);
            $att = $stmt->fetch();
            if (!$att) fail('Allegato non trovato.', 404);
            requireWorkspaceRole($pdo, $user, (int)$att['board_id'], ['editor', 'admin']);
            $pdo->prepare("DELETE FROM card_attachments WHERE id = ?")->execute([$id]);
            @unlink($uploadsRoot . '/' . basename($att['stored_name']));
            reply(['ok' => true]);
        }

        case 'password:change': {
            $body = jsonBody();
            $current = (string)($body['current_password'] ?? '');
            $new = (string)($body['new_password'] ?? '');
            if (strlen($new) < 8) fail('La nuova password deve avere almeno 8 caratteri.');
            $stmt = $pdo->prepare("SELECT password_hash FROM users WHERE id = ?");
            $stmt->execute([$user['id']]);
            $hash = (string)$stmt->fetchColumn();
            if (!password_verify($current, $hash)) fail('Password attuale non corretta.', 401);
            $pdo->prepare("UPDATE users SET password_hash = ? WHERE id = ?")
                ->execute([password_hash($new, PASSWORD_DEFAULT), $user['id']]);
            reply(['ok' => true]);
        }

        case 'site:update': {
            if (empty($user['is_admin'])) fail('Solo un admin globale può modificare il sito.', 403);
            $body = jsonBody();
            $name = cleanText($body['name'] ?? '', 100);
            $logo = cleanText($body['logo_url'] ?? '', 500);
            $description = cleanText($body['description'] ?? '', 255);
            if ($name === '') fail('Inserisci il nome del sito.');
            if ($logo !== '' && !filter_var($logo, FILTER_VALIDATE_URL)) fail('URL del logo non valido.');
            $pdo->prepare("UPDATE site_settings SET site_name = ?, logo_url = ?, description = ? WHERE id = 1")
                ->execute([$name, $logo ?: null, $description ?: 'Project workspace']);
            reply(['ok' => true, 'site' => siteSettings($pdo)]);
        }

        case 'members:list': {
            $workspaceId = intId($_GET['workspace_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['admin']);
            $search = cleanText($_GET['q'] ?? '', 32);
            $like = '%' . $search . '%';
            $stmt = $pdo->prepare("
                SELECT u.id, u.username, u.is_admin, wm.role
                FROM users u
                LEFT JOIN workspace_members wm
                  ON wm.user_id = u.id AND wm.workspace_id = ?
                WHERE u.status = 'active' AND u.username LIKE ?
                ORDER BY (wm.role IS NOT NULL) DESC, u.username
                LIMIT 100
            ");
            $stmt->execute([$workspaceId, $like]);
            $rows = $stmt->fetchAll();
            foreach ($rows as &$row) {
                $row['id'] = (int)$row['id'];
                $row['is_admin'] = (bool)$row['is_admin'];
            }
            unset($row);
            reply(['ok' => true, 'users' => $rows]);
        }

        case 'member:set': {
            $body = jsonBody();
            $workspaceId = intId($body['workspace_id'] ?? null);
            requireWorkspaceRole($pdo, $user, $workspaceId, ['admin']);
            $targetUserId = intId($body['user_id'] ?? null);
            $role = (string)($body['role'] ?? '');
            if ($role === '') {
                if ($targetUserId === (int)$user['id'] && empty($user['is_admin'])) fail('Non puoi rimuovere te stesso dal workspace.');
                $pdo->prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
                    ->execute([$workspaceId, $targetUserId]);
            } else {
                if (!in_array($role, ['viewer', 'editor', 'admin'], true)) fail('Ruolo non valido.');
                $stmt = $pdo->prepare("SELECT 1 FROM users WHERE id = ? AND status='active'");
                $stmt->execute([$targetUserId]);
                if (!$stmt->fetchColumn()) fail('Utente non attivo.', 404);
                $pdo->prepare("
                    INSERT INTO workspace_members (workspace_id, user_id, role)
                    VALUES (?, ?, ?)
                    ON DUPLICATE KEY UPDATE role = VALUES(role)
                ")->execute([$workspaceId, $targetUserId, $role]);
            }
            reply(['ok' => true]);
        }

        case 'admin:users': {
            if (empty($user['is_admin'])) fail('Solo un admin globale può gestire gli utenti.', 403);
            $stmt = $pdo->query("
                SELECT id, username, status, is_admin, created_at
                FROM users
                ORDER BY FIELD(status, 'pending', 'active', 'rejected'), created_at DESC
                LIMIT 200
            ");
            $rows = $stmt->fetchAll();
            foreach ($rows as &$row) {
                $row['id'] = (int)$row['id'];
                $row['is_admin'] = (bool)$row['is_admin'];
            }
            unset($row);
            reply(['ok' => true, 'users' => $rows]);
        }

        case 'admin:user-status': {
            if (empty($user['is_admin'])) fail('Solo un admin globale può gestire gli utenti.', 403);
            $body = jsonBody();
            $targetUserId = intId($body['user_id'] ?? null);
            $status = (string)($body['status'] ?? '');
            if (!in_array($status, ['active', 'rejected'], true)) fail('Stato non valido.');
            $pdo->prepare("
                UPDATE users
                SET status = ?, approved_at = ?, approved_by = ?
                WHERE id = ?
            ")->execute([
                $status,
                $status === 'active' ? date('Y-m-d H:i:s') : null,
                $status === 'active' ? $user['id'] : null,
                $targetUserId,
            ]);
            reply(['ok' => true]);
        }

        case 'admin:user-admin': {
            if (empty($user['is_admin'])) fail('Solo un admin globale può nominare altri admin.', 403);
            $body = jsonBody();
            $targetUserId = intId($body['user_id'] ?? null);
            $isAdmin = !empty($body['is_admin']) ? 1 : 0;
            if ($targetUserId === (int)$user['id'] && !$isAdmin) fail('Non puoi revocare il tuo stesso ruolo admin.');
            $pdo->prepare("UPDATE users SET is_admin = ? WHERE id = ? AND status='active'")
                ->execute([$isAdmin, $targetUserId]);
            reply(['ok' => true]);
        }

        case 'admin:user-password': {
            if (empty($user['is_admin'])) fail('Solo un admin globale può reimpostare password.', 403);
            $body = jsonBody();
            $targetUserId = intId($body['user_id'] ?? null);
            $new = (string)($body['new_password'] ?? '');
            if (strlen($new) < 8) fail('La nuova password deve avere almeno 8 caratteri.');
            $stmt = $pdo->prepare("UPDATE users SET password_hash = ? WHERE id = ? AND status='active'");
            $stmt->execute([password_hash($new, PASSWORD_DEFAULT), $targetUserId]);
            if (!$stmt->rowCount()) fail('Utente attivo non trovato.', 404);
            reply(['ok' => true]);
        }

        default:
            fail('Azione non disponibile.', 404);
    }
} catch (Throwable $e) {
    if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
    error_log('[PRJ] API error [' . $action . ']: ' . $e->getMessage());
    fail('Si è verificato un errore sul server.', 500);
}
