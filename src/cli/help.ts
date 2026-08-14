import pc from 'picocolors';
import { MAX_MODEL_CATALOG, VERSION } from '../constants.js';

export function rootHelpText(): string {
  return `${pc.bold('clodex')} v${VERSION}
Bridge Claude Code to OpenAI and Grok models with API-key or subscription access.

${pc.bold('Usage:')}
  clodex
  clodex start
  clodex stop
  clodex claude [options] [claude-flags]
  clodex daemon <install|run|status|restart|stop|uninstall>
  clodex accounts <list|add|select|remove|usage>
  clodex server [options]
  clodex patch [--restore]
  clodex models
  clodex favorites
  clodex providers
  clodex --help
  clodex --version

${pc.bold('Root options:')}
  -h, --help       Show this help
  -v, --version    Show version

${pc.bold('Commands:')}
  (none)      Open the live daemon dashboard
  start       Start the persistent daemon without opening the dashboard
  stop        Stop the persistent daemon
  claude      Launch Claude Code bridged to OpenAI models
  daemon      Manage the persistent per-user Clodex service
  accounts    Manage OpenAI and SuperGrok logins (manual switching only)
  server      Run a foreground gateway (endpoint or proxy mode)
  patch       Patch the Claude Code binary so clodex models are first-class
  models      Manage favorite models and aliases (max ${MAX_MODEL_CATALOG})
  favorites   Alias for models
  providers   Add or configure OpenAI and Grok providers

${pc.bold('Claude transport:')}
  clodex claude always uses the persistent daemon's single local endpoint.

${pc.bold('Server bridge modes:')}
  clodex server supports endpoint and proxy modes for standalone gateway use.

${pc.bold('Examples:')}
  clodex claude
  clodex models
  clodex patch
  clodex server
  clodex claude -c
  clodex claude -- --print "hello"`;
}

export function claudeHelpText(): string {
  return `${pc.bold('clodex claude')} v${VERSION}
Launch Claude Code bridged to OpenAI models.

${pc.bold('Usage:')}
  clodex claude [options] [claude-flags]
  clodex claude --help
  clodex claude --version

${pc.bold('Options:')}
  --endpoint   Accepted for compatibility; the daemon always uses its endpoint
  --save-mode  Accepted with --endpoint for compatibility
  --dry-run    Run the wizard but show a preview instead of launching Claude Code
  --trace      Write debug logs to ~/.clodex/logs/ and show errors on exit
  --fast       Request Fast processing for OpenAI OAuth models in this launch
  --provider   Boot provider id (skip wizard when paired with --model or in print mode)
  --model      Boot model id (skip wizard when paired with --provider or in print mode)
  --help       Show this command help
  --version    Show version

${pc.bold('Providers:')}
  openai         OpenAI API key (platform.openai.com)
  openai-oauth   ChatGPT/Codex plan OAuth — sign in with clodex accounts add openai
  xai-oauth      SuperGrok subscription OAuth — sign in with clodex accounts add xai

${pc.bold('Model switching:')}
  Run clodex models to save favorites (max ${MAX_MODEL_CATALOG}).
  When favorites exist, the daemon endpoint exposes a multi-route catalog and
  Claude Code /model lists your starting model plus favorites for live switching.
  With no favorites, launch uses a single model.

${pc.bold('Transport:')}
  Every Claude launch uses the persistent daemon's single endpoint.
  Standalone proxy mode remains available through clodex server --proxy.

${pc.bold('Note:')}
  Claude Code may save the launched model to ~/.claude/settings.json.
  Bare claude later can still show that model — reset with claude --model sonnet.

${pc.bold('Examples:')}
  clodex claude
  clodex claude -c
  clodex claude --resume abc-123
  clodex claude --dry-run -c
  clodex claude --trace --resume abc-123
  clodex claude --endpoint
  clodex claude --endpoint --save-mode
  clodex claude --provider openai-oauth --model gpt-5.6-sol
  clodex claude -- --print "hello"
  clodex claude -- --dangerously-skip-permissions`;
}

export function serverHelpText(): string {
  return `${pc.bold('clodex server')} v${VERSION}
Run a foreground gateway bridging Anthropic-format requests to OpenAI models.
Two modes: ${pc.bold('endpoint')} (an Anthropic-format HTTP gateway you point clients at) and
${pc.bold('proxy')} (a selective api.anthropic.com MITM proxy; clients keep their Anthropic
auth while clodex: models route to OpenAI).

${pc.bold('Usage:')}
  clodex server [--endpoint | --proxy] [options]
  clodex server --help
  clodex server --version

${pc.bold('Common options (both modes):')}
  --endpoint                   Endpoint mode for this run
  --proxy                      Proxy mode for this run (default when nothing is
                               saved; local only)
  --save-mode                  With --endpoint/--proxy: save that mode as the
                               server default
  --port <1-65535>             Listen port (default 17645)
  --no-discovery               Do not advertise this server in
                               ~/.clodex/server-runtime.json, so the
                               clodex-claude wrapper never bridges to it
                               (CLODEX_NO_DISCOVERY=1 works too)
  --ws-diagnostics             Log sanitized request envelopes and WebSocket
                               head decisions
  --help, --version            Help / version

${pc.bold('Endpoint mode only')} ${pc.dim('(error if combined with --proxy)')}:
  --quick, --saved             Start immediately from saved/default settings,
                               skipping the wizard
  --listen local|network       One-run listen mode override
  --providers all|favorites|id1,id2
                               One-run provider catalog override
  --mask-gateway-ids           Mask vendor names in discovery model ids (see below)
  --no-mask-gateway-ids        Expose unmasked discovery model ids
  --password <value>           One-run network-mode server password

${pc.bold('Proxy mode only:')}
  (no extra options — proxy mode takes only the common options above)

${pc.bold('Bare clodex server:')}
  Uses the saved default mode (proxy if none saved). Proxy mode starts
  immediately. Endpoint mode on a TTY opens a short wizard: start from saved
  settings, or configure — favorites-only catalog?, which providers to expose,
  discovery-id masking, listen local/network (network asks for a password).
  Without a TTY (or with --quick / any endpoint-mode option) it skips all
  prompts and starts from saved settings; network mode then needs a saved
  password or --password.

${pc.bold('--mask-gateway-ids explained:')}
  Endpoint-mode discovery ids look like anthropic-openai-oauth__gpt-5.6.
  Some Claude clients validate model names (Claude Desktop / Cowork pickers,
  Claude Code skill/agent "model:" frontmatter) and reject or filter ids that
  contain non-Anthropic vendor names. Masking reverses the provider and model
  segments (anthropic-htuao-ianepo__6.5-tpg) so vendor strings never appear
  literally; display names stay readable ("GPT 5.6 (OpenAI)"), and the
  gateway accepts both masked and unmasked ids in requests. Tradeoff: the ids
  are unreadable, so copy them exactly from the printed catalog. Masking is on
  by default; use --no-mask-gateway-ids for clients that don't need it.

${pc.bold('Proxy mode env:')}
  Start clodex server --proxy, then export the HTTPS_PROXY, HTTP_PROXY,
  and NODE_EXTRA_CA_CERTS values it prints. Do not set ANTHROPIC_BASE_URL.

${pc.bold('Gateway endpoints (endpoint mode):')}
  Anthropic-compatible:  ANTHROPIC_BASE_URL=http://127.0.0.1:17645/anthropic
  OpenAI-compatible:     OPENAI_BASE_URL=http://127.0.0.1:17645/openai/v1
  API key: use anything locally; use the server password in network mode.

${pc.bold('Examples:')}
  # Endpoint gateway serving only your favorites, no prompts, for a local client
  clodex server --endpoint --quick --providers favorites

  # Proxy mode for an existing-auth Claude Code (export the env it prints)
  clodex server --proxy`;
}

export function modelsHelpText(): string {
  return `${pc.bold('clodex favorites')} v${VERSION}
Manage favorite models for mid-session switching.

${pc.bold('Usage:')}
  clodex favorites
  clodex models --list
  clodex models --alias sol=clodex:openai-oauth:gpt-5.6-sol
  clodex models --unalias sol
  clodex models
  clodex favorites --help
  clodex favorites --version

${pc.bold('Behavior:')}
  Opens an interactive manager to add or remove favorites.
  Search all providers at once (paginated results) or browse one provider at a time.
  Favorites are saved to ~/.clodex/config.json (max ${MAX_MODEL_CATALOG}).
  --list prints the exact clodex:<provider-id>:<model-id> names available in
  proxy mode, without opening the interactive manager.
  --alias <name=target> saves a short name for a proxy-mode favorite. The
  target is clodex:<provider-id>:<model-id> (the clodex: prefix is optional).
  Alias names are stored lowercase and cannot use client-reserved model names.
  --unalias <name> removes a saved short name.

${pc.bold('How it works:')}
  claude and server use the global favorites list.
  Favorites appear in the /model switch menu (endpoint mode) and are routable
  by name in proxy mode. clodex patch bakes favorites + aliases into the
  Claude Code binary so they pass model validation and report real context.

${pc.bold('Examples:')}
  clodex favorites
  clodex models --alias sol=clodex:openai-oauth:gpt-5.6-sol
  clodex claude    # switch menu active when favorites are set`;
}

export function patchHelpText(): string {
  return `${pc.bold('clodex patch')} v${VERSION}
Patch the installed Claude Code binary so clodex favorites and aliases are
first-class: accepted by the Agent tool, listed in /model, resolved to their
real ids, and reporting the correct context window.

${pc.bold('Usage:')}
  clodex patch
  clodex patch --restore
  clodex patch --help

${pc.bold('Options:')}
  --restore    Restore the pristine (unpatched) Claude Code binary
  --trace      Show per-patch-site results (OK/SKIP/FAIL)

${pc.bold('Behavior:')}
  The patch map is built automatically from your clodex favorites and aliases
  (clodex models); context windows come from provider metadata. A pristine
  per-version backup is kept, and a manifest (~/.clodex/patch-state.json)
  makes re-runs no-ops until your config or Claude Code version changes —
  then the binary is restored first and re-patched fresh.
  Run clodex patch again after every claude update.`;
}

export function printHelp(text: string): void {
  console.log(`\n${text}\n`);
}
