#!/usr/bin/env bash
# Run from the repo root:  bash scripts/ci-require-secrets.test.sh
#
# Inverts every arm of the guard. The four PASS cases matter as much as the
# FAIL cases: a guard that refuses everything is as useless as one that
# refuses nothing. The LEAK assertion is the third axis — a guard that prints
# a secret into a public CI log is a worse defect than the one it catches.
#
# Two bugs were found by running this, not by reading the guard:
#   * a trailing newline PASSED, because grep strips the line terminator
#     before matching [[:space:]] — the commonest paste error, invisible.
#   * this test reported a false LEAK on every newline case, because grep -F
#     treats a newline in the pattern as a separator and the empty second
#     pattern matches every line.
# Inverts every arm of scripts/ci-require-secrets.sh.
# A guard that cannot fail is theatre; a guard that fails on everything is
# equally useless, so the PASS cases matter as much as the FAIL cases.
G="scripts/ci-require-secrets.sh"
GOOD_URL='https://nmuntxrcdksyhsdywpan.supabase.co'
GOOD_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123'
# NOT shaped like a real Supabase PAT on purpose: GitHub push protection
# blocks a literal that merely LOOKS like one, and it is right to. The guard
# only tests token SHAPE (whitespace, quotes, NAME= prefix), never its format,
# so any non-empty value exercises the same arms.
GOOD_TOK='dummy-token-for-shape-tests-only'

pass=0; failed=0
run() { # run <expect_rc> <label> <job> <url> <key> <token>
  local want="$1" label="$2" job="$3"
  local out rc
  out=$(VITE_TEST_SUPABASE_URL="$4" VITE_TEST_SUPABASE_ANON_KEY="$5" SUPABASE_ACCESS_TOKEN="$6" \
        bash "$G" "$job" 2>&1); rc=$?
  if [ "$rc" = "$want" ]; then
    pass=$((pass+1)); printf '  ok    %-52s rc=%s\n' "$label" "$rc"
  else
    failed=$((failed+1)); printf '  FAIL  %-52s rc=%s want=%s\n     %s\n' "$label" "$rc" "$want" "$(echo "$out" | head -1)"
  fi
  # ⚠ A guard that leaks a secret into the log is a worse defect than the one
  # it catches. Assert no supplied value ever appears in the output.
  # ⚠ Strip whitespace from the NEEDLE first. `grep -F` treats a newline in the
  # pattern as a pattern SEPARATOR, so a value ending in "\n" becomes two
  # patterns — the second empty — and an empty pattern matches every line. The
  # first version of this check reported a leak on every newline case.
  for v in "$4" "$5" "$6"; do
    v=$(printf '%s' "$v" | tr -d '[:space:]')
    if [ ${#v} -ge 8 ] && printf '%s' "$out" | grep -qF -- "$v"; then
      failed=$((failed+1)); printf '  LEAK  %-52s value appeared in output!\n' "$label"
    fi
  done
}

echo "== PASS cases (must return 0) =="
run 0 "isolation, all well-formed"            isolation   "$GOOD_URL" "$GOOD_KEY" ""
run 0 "invariants, token only"                invariants  ""          ""          "$GOOD_TOK"
run 0 "invariants ignores a broken URL"       invariants  "GARBAGE"   ""          "$GOOD_TOK"
run 0 "golden-path, all three"                golden-path "$GOOD_URL" "$GOOD_KEY" "$GOOD_TOK"

echo "== URL arms (must return 1) =="
run 1 "url empty"                             isolation   ""                                        "$GOOD_KEY" ""
run 1 "url pasted as NAME=value"              isolation   "VITE_TEST_SUPABASE_URL=$GOOD_URL"        "$GOOD_KEY" ""
run 1 "url double-quoted"                     isolation   "\"$GOOD_URL\""                           "$GOOD_KEY" ""
run 1 "url single-quoted"                     isolation   "'$GOOD_URL'"                             "$GOOD_KEY" ""
run 1 "url trailing slash"                    isolation   "$GOOD_URL/"                              "$GOOD_KEY" ""
run 1 "url with a path"                       isolation   "$GOOD_URL/rest/v1"                       "$GOOD_KEY" ""
run 1 "url http not https"                    isolation   "http://nmuntxrcdksyhsdywpan.supabase.co" "$GOOD_KEY" ""
run 1 "url trailing whitespace"               isolation   "$GOOD_URL "                              "$GOOD_KEY" ""
run 1 "url UNESCAPED-DOT case abcXsupabaseYco" isolation  "https://abcXsupabaseYco"                 "$GOOD_KEY" ""
run 1 "url TRAILING NEWLINE (grep would miss)" isolation  "$GOOD_URL
"                                                                                                   "$GOOD_KEY" ""
run 1 "url leading newline"                   isolation   "
$GOOD_URL"                                                                                          "$GOOD_KEY" ""
run 1 "url POINTS AT PRODUCTION"              isolation   "https://rfsvmhcqeiyrxivbmpel.supabase.co" "$GOOD_KEY" ""

echo "== ANON KEY arms (must return 1) =="
run 1 "key empty"                             isolation   "$GOOD_URL" ""                                  ""
run 1 "key pasted as NAME=value"              isolation   "$GOOD_URL" "VITE_TEST_SUPABASE_ANON_KEY=$GOOD_KEY" ""
run 1 "key double-quoted"                     isolation   "$GOOD_URL" "\"$GOOD_KEY\""                     ""
run 1 "key with embedded space"               isolation   "$GOOD_URL" "$GOOD_KEY x"                       ""
run 1 "key with trailing newline"             isolation   "$GOOD_URL" "$GOOD_KEY
"                                                                                                          ""

echo "== TOKEN arms (must return 1) =="
run 1 "token empty (invariants)"              invariants  ""          ""          ""
run 1 "token pasted (invariants)"             invariants  ""          ""          "SUPABASE_ACCESS_TOKEN=$GOOD_TOK"
run 1 "token quoted (golden-path)"            golden-path "$GOOD_URL" "$GOOD_KEY" "\"$GOOD_TOK\""
run 1 "golden-path missing token"             golden-path "$GOOD_URL" "$GOOD_KEY" ""

echo "== wiring, not secrets (must return 2) =="
run 2 "unknown job name"                      typo        "$GOOD_URL" "$GOOD_KEY" "$GOOD_TOK"
run 2 "no job argument"                       ""          "$GOOD_URL" "$GOOD_KEY" "$GOOD_TOK"

echo
echo "passed=$pass  failed=$failed"
[ "$failed" = 0 ] || exit 1
