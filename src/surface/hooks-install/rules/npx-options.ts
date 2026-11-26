const words = (text: string): ReadonlySet<string> => new Set(text.trim().split(/\s+/));

export const NPX_VALUED = words(`
  _auth access also audit-level auth-type before ca cache cache-max cache-min cafile call cert cidr cpu depth diff
  diff-dst-prefix diff-src-prefix diff-unified editor expect-result-count fetch-retries fetch-retry-factor
  fetch-retry-maxtimeout fetch-retry-mintimeout fetch-timeout git globalconfig heading https-proxy include
  init-author-email init-author-name init-author-url init-license init-module init-type init-version
  init.author.email init.author.name init.author.url init.license init.module init.version install-strategy key libc
  local-address location lockfile-version loglevel logs-dir logs-max maxsockets message n node-arg node-gyp
  node-options noproxy npm omit only os otp pack-destination package prefix preid provenance-file proxy registry
  replace-registry-host save-prefix sbom-format sbom-type scope script-shell searchexclude searchlimit searchopts
  searchstaleness shell tag tag-version-prefix umask user-agent userconfig viewer which workspace
`);

export const NPX_SWITCHES = words(`
  all allow-same-version always-spawn audit bin-links browser color commit-hooks description dev
  diff-ignore-all-space diff-name-only diff-no-prefix diff-text dry-run engine-strict expect-results force
  foreground-scripts format-package-lock fund git-tag-version global global-style if-present ignore-existing
  ignore-scripts include-staged include-workspace-root init-private install-links json legacy-bundling
  legacy-peer-deps link long no-install offline omit-lockfile-registry-resolved optional package-lock
  package-lock-only parseable prefer-dedupe prefer-offline prefer-online production progress provenance read-only
  rebuild-bundle save save-bundle save-dev save-exact save-optional save-peer save-prod shell-auto-fallback
  shrinkwrap sign-git-commit sign-git-tag strict-peer-deps strict-ssl timing unicode update-notifier usage version
  versions workspaces workspaces-update yes
`);

export const NPX_NOT_RUN = words('call usage version');

const SHORTHAND_ROWS = `
  enjoy-by --before
  d --loglevel info
  dd --loglevel verbose
  ddd --loglevel silly
  quiet --loglevel warn
  q --loglevel warn
  s --loglevel silent
  silent --loglevel silent
  verbose --loglevel verbose
  desc --description
  help --usage
  local --no-global
  no --no-yes
  porcelain --parseable
  readonly --read-only
  reg --registry
  iwr --include-workspace-root
  ws --workspaces
  a --all
  c --call
  f --force
  g --global
  L --location
  l --long
  m --message
  p --package
  C --prefix
  S --save
  B --save-bundle
  D --save-dev
  E --save-exact
  O --save-optional
  P --save-prod
  ? --usage
  H --usage
  h --usage
  v --version
  w --workspace
  y --yes
  shell --script-shell
`;

export const NPX_SHORTHANDS: ReadonlyMap<string, readonly string[]> = new Map(
  SHORTHAND_ROWS.trim()
    .split('\n')
    .map((row): [string, readonly string[]] => {
      const [key, ...expansion] = row.trim().split(' ');
      return [key, expansion];
    }),
);
