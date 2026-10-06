// The secret-assignment shapes both the detectSecret and the scrubForSharing tables run, so the two lists cannot drift.

/** Built at runtime, so no secret-shaped literal sits in source: 14 characters with a digit. */
export const ASSIGNED_SECRET = 'Hunter2' + 'Hunter2';
const V = ASSIGNED_SECRET;

/** Each line leaks ASSIGNED_SECRET unless the secret-assignment pattern catches it. */
export const ASSIGNED_SECRET_LINES: readonly string[] = [
  `PGPASSWORD=${V} psql -h db -U app`,
  `{"password": "${V}"}`,
  `"api_key": "${V}"`,
  `'db_password': '${V}'`,
  `const dbPassword = "${V}";`,
  `clientSecret: "${V}"`,
  `accessToken: '${V}'`,
  `SECRETKEY=${V}`,
  `MYSQL_PWD=${V}`,
  `DB_PASS=${V}`,
  `password := "${V}"`,
  `mysql -u root --password ${V}`,
  `VERY_LONG_APPLICATION_NAME_DB_PASSWORD=${V}`,
  `DB_PASSWORD=${V}`,
  `password: ${V}`,
  `$env:DB_PASSWORD = "${V}"`,
  `AWS_SECRET_ACCESS_KEY=${V}`,
  `CLIENT_SECRET: ${V}`,
  `SECRET_KEY_BASE=${V}`,
];

/** Config whose names hold a keyword without ending in one, or end in a shell word: none may flag or lose text to a secret mask. */
export const ORDINARY_CONFIG_LINES: readonly string[] = [
  'token_url = "/api/v1/oauth/token"',
  'TOKEN_PATH=/v1/auth/token/refresh',
  'secret_version: projects/123456/secrets/x/versions/3',
  'private_key_file: certs/server-2024.pem',
  'api_key_header = "X-Api-Key-V2"',
  'token_type_hint = "refresh_token_v2"',
  'password_policy_id = pol-0a1b2c3d4e5f',
  'secret_name: my-service-secret-v2',
  'token_count = 1234567890123',
  'PWD=/home/kit/dev/project2024',
  'OLDPWD=/c/Users/kit/dev2024',
  'bypass_mode = "strict-2024-v2"',
  'compass: "north-2024-heading"',
];
