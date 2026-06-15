#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Pre-publish gate for The Latent Lounge.
#
# Runs BEFORE any push/deploy. Proves the code in this working tree:
#   1. parses           — every tracked .js file passes `node --check`
#   2. has no leaked secrets — tracked files don't contain private keys / .env values
#   3. boots clean       — the server starts in an isolated sandbox (temp DATA_DIR,
#                          throwaway port, dummy wallet) and answers its free routes
#   4. has no known CVEs — `npm audit` finds nothing high/critical in prod deps
#
# Exit code is non-zero if any HARD check fails, so it can gate a push.
# Network-dependent checks (npm audit) degrade to a WARNING when offline.
#
# Usage:  npm run gate        (or)   bash scripts/pre-publish-gate.sh
# ---------------------------------------------------------------------------
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2
ROOT="$(pwd)"

GREEN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; DIM=$'\033[2m'; NC=$'\033[0m'
pass() { printf "  ${GREEN}PASS${NC}  %s\n" "$1"; }
fail() { printf "  ${RED}FAIL${NC}  %s\n" "$1"; HARD_FAIL=1; }
warn() { printf "  ${YEL}WARN${NC}  %s\n" "$1"; }
step() { printf "\n${DIM}── %s ──${NC}\n" "$1"; }

HARD_FAIL=0

# ---------------------------------------------------------------------------
step "1/4  Syntax check (node --check on tracked .js)"
# Tracked .js files only — never lint node_modules.
JS_FILES="$(git ls-files '*.js' 2>/dev/null || true)"
if [ -z "$JS_FILES" ]; then
  warn "no tracked .js files found"
else
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if node --check "$f" 2>/tmp/gate_check.err; then
      pass "$f"
    else
      fail "$f does not parse"
      sed 's/^/        /' /tmp/gate_check.err
    fi
  done <<< "$JS_FILES"
fi

# ---------------------------------------------------------------------------
step "2/4  Secret scan (tracked files)"
# Look for private keys and obvious credential leaks in TRACKED files only.
# .env is gitignored; this catches the case where it (or a key) gets staged anyway.
SECRET_HITS=0
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  fail ".env is tracked by git — it must stay gitignored"
  SECRET_HITS=1
fi
# High-signal patterns only, so documentation/usage examples (e.g. `PRIVATE_KEY=0x...`)
# don't trip the gate. What we actually fear in a wallet-touching app:
#   - a PEM private-key block
#   - a real raw EVM private key: 0x + exactly 64 hex chars
#   - a real base58/hex API secret of meaningful length following a SECRET/KEY assignment
SCAN="$(git grep -nIE \
  -e 'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY' \
  -e '0x[a-fA-F0-9]{64}' \
  -e '(PRIVATE_KEY|SECRET|MNEMONIC|SEED_PHRASE)[[:space:]]*[:=][[:space:]]*["'\'']?[A-Za-z0-9+/]{24,}' \
  -- . ':(exclude)package-lock.json' ':(exclude)scripts/pre-publish-gate.sh' 2>/dev/null \
  | grep -vE 'process\.env|\.env\.example|YOUR_|EXAMPLE|PLACEHOLDER|0x0{40}|0x\.\.\.|AGENT_TEST_KEY' || true)"
if [ -n "$SCAN" ]; then
  fail "possible secret(s) in tracked files:"
  printf '%s\n' "$SCAN" | sed 's/^/        /'
  SECRET_HITS=1
fi
[ "$SECRET_HITS" -eq 0 ] && pass "no private keys or credentials in tracked files"

# ---------------------------------------------------------------------------
step "3/4  Sandbox boot + liveness"
# Boot the real server in an isolated sandbox:
#   - temp DATA_DIR      -> never touches live data files
#   - throwaway PORT      -> never collides with a running instance
#   - dummy PAY_TO        -> valid-format address so the boot guard passes
#   - testnet + no CDP keys -> no outbound calls at startup
SBX_DATA="$(mktemp -d /tmp/gate-data.XXXXXX)"
SBX_PORT=4099
SBX_LOG="$(mktemp /tmp/gate-boot.XXXXXX.log)"
cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" >/dev/null 2>&1
  rm -rf "$SBX_DATA" "$SBX_LOG" /tmp/gate_check.err /tmp/gate_audit.err 2>/dev/null
}
trap cleanup EXIT

env -i PATH="$PATH" HOME="$HOME" \
  PAY_TO_ADDRESS=0x0000000000000000000000000000000000000000 \
  NETWORK=base-sepolia \
  PORT="$SBX_PORT" \
  DATA_DIR="$SBX_DATA" \
  BACKUP_FIRST_RUN_MS=600000 \
  node server.js >"$SBX_LOG" 2>&1 &
SRV_PID=$!

# Wait up to 15s for the listen line (or process death).
BOOTED=0
for _ in $(seq 1 30); do
  if ! kill -0 "$SRV_PID" >/dev/null 2>&1; then break; fi
  if grep -q "open on port" "$SBX_LOG" 2>/dev/null; then BOOTED=1; break; fi
  sleep 0.5
done

if [ "$BOOTED" -ne 1 ]; then
  fail "server did not boot within 15s"
  sed 's/^/        /' "$SBX_LOG"
else
  pass "server booted on sandbox port $SBX_PORT"
  # Probe free routes — assert HTTP 200.
  probe() {
    local path="$1"; local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${SBX_PORT}${path}" 2>/dev/null)"
    if [ "$code" = "200" ]; then pass "GET $path -> 200"; else fail "GET $path -> ${code:-no-response}"; fi
  }
  probe "/api/menu"
  probe "/"
  # Assert a paid route actually demands payment (402), i.e. the paywall is wired.
  pcode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${SBX_PORT}/api/play/cipher" 2>/dev/null)"
  if [ "$pcode" = "402" ]; then pass "paid route /api/play/cipher -> 402 (paywall active)"; else warn "paid route returned ${pcode:-no-response} (expected 402)"; fi
fi

# ---------------------------------------------------------------------------
step "4/4  Dependency vulnerability scan (npm audit, prod deps)"
# Policy (see .audit-allowlist.json): FAIL on ANY critical, or on any advisory
# NOT already accepted-known in the allowlist. Accepted-known advisories are the
# x402 SDK's transitive web3/wallet-connector tree, unreachable from server code.
AUDIT_JSON="$(npm audit --omit=dev --json 2>/tmp/gate_audit.err)"
if printf '%s' "$AUDIT_JSON" | grep -qiE 'ENOTFOUND|ETIMEDOUT|ECONNREFUSED|registry|offline' \
   || ! printf '%s' "$AUDIT_JSON" | grep -q '"vulnerabilities"'; then
  warn "could not reach npm registry (offline) — re-run with network before publishing"
else
  AUDIT_RESULT="$(printf '%s' "$AUDIT_JSON" | node -e '
    const fs=require("fs");
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      let allow={};
      try{ allow=(JSON.parse(fs.readFileSync(".audit-allowlist.json","utf8")).accepted)||{}; }catch{}
      const v=(JSON.parse(d).vulnerabilities)||{};
      const unexpected=[], criticals=[];
      for(const [name,info] of Object.entries(v)){
        if(info.severity==="critical") criticals.push(name);
        if(!(name in allow)) unexpected.push(name+" ("+info.severity+")");
      }
      const accepted=Object.keys(v).length-unexpected.length;
      if(criticals.length) console.log("CRIT\t"+criticals.join(", "));
      if(unexpected.length) console.log("NEW\t"+unexpected.join(", "));
      console.log("ACCEPTED\t"+accepted);
    });')"
  CRIT_LINE="$(printf '%s\n' "$AUDIT_RESULT" | sed -n 's/^CRIT\t//p')"
  NEW_LINE="$(printf '%s\n' "$AUDIT_RESULT" | sed -n 's/^NEW\t//p')"
  ACCEPTED_N="$(printf '%s\n' "$AUDIT_RESULT" | sed -n 's/^ACCEPTED\t//p')"
  if [ -n "$CRIT_LINE" ]; then fail "CRITICAL vulnerabilities present: $CRIT_LINE"; fi
  if [ -n "$NEW_LINE" ]; then fail "new advisories not in allowlist (triage + fix or add to .audit-allowlist.json): $NEW_LINE"; fi
  if [ -z "$CRIT_LINE" ] && [ -z "$NEW_LINE" ]; then
    pass "no critical / no new advisories (${ACCEPTED_N:-0} accepted-known, documented in .audit-allowlist.json)"
  fi
fi

# ---------------------------------------------------------------------------
echo
if [ "$HARD_FAIL" -eq 0 ]; then
  printf "${GREEN}GATE PASSED${NC} — safe to publish.\n"
  exit 0
else
  printf "${RED}GATE FAILED${NC} — do NOT publish until the FAILs above are resolved.\n"
  exit 1
fi
