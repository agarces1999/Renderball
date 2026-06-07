#!/usr/bin/env bash
# QA-fix visual validation harness (QA C/D/E + B batch).
#
# Regenerates the two QA-failure brands (Fuse → was maroon, should lead blue;
# Tony's → was brown, should lead red) plus one new brand (Duolingo → vivid
# green signature), builds each through the now-gated pipeline, and runs
# scripts/qa-verify.mjs on each. Prints preview URLs to eyeball C1 (signature
# color leads) and D2 (chrome variety) — those are visual, not gateable.
#
# Requires: Anthropic API credits + PEXELS_API_KEY in .env.local. Run when
# credits are topped up:  bash scripts/qa-validate.sh
set -u
BASE="http://localhost:3000"
OUT="/tmp/renderball-qa-validate"
mkdir -p "$OUT"
cd "$(dirname "$0")/.." || exit 1

echo "=== restart dev server (load latest gates) ==="
lsof -ti tcp:3000 | xargs kill -9 2>/dev/null; sleep 2
nohup npm run dev > "$OUT/devserver.log" 2>&1 &
for i in $(seq 1 90); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE/new" 2>/dev/null)" = "200" ] && { echo "server up (${i}s)"; break; }; sleep 1; done

# brand label | url | prompt
run_brand () {
  local key="$1" url="$2" prompt="$3"
  echo; echo "=== $key — generate ==="
  local payload
  payload=$(node -e 'const a=process.argv;console.log(JSON.stringify({prompt:a[1],url:a[2],distribution_format:"landscape",duration_seconds:30,moment_count:5}))' "$prompt" "$url")
  curl -s --max-time 700 -X POST "$BASE/api/dev/generate" -H 'content-type: application/json' -d "$payload" -o "$OUT/${key}_gen.json"
  local sid
  sid=$(node -e 'try{process.stdout.write(require(process.argv[1]).scriptId||"")}catch(e){}' "$OUT/${key}_gen.json")
  [ -z "$sid" ] && { echo "  GEN FAILED: $(head -c 300 "$OUT/${key}_gen.json")"; return 1; }
  echo "  script $sid"
  echo "=== $key — build (gated) ==="
  curl -s -o "$OUT/${key}_build.json" -w "  HTTP %{http_code}\n" -X POST "$BASE/api/preview/build" -H 'content-type: application/json' -d "{\"scriptId\":\"$sid\"}" --max-time 1000
  grep -o '"ok":[a-z]*' "$OUT/${key}_build.json" | head -1
  node scripts/qa-verify.mjs "$sid" "$key"
}

run_brand "fuse"    "fusefinance.com"    "Fuse — modern finance infrastructure. Open loans and accounts like a fintech, without building it in-house. Tell the story: the legacy build-vs-buy trap, the platform, configurable workflows, who it's for, and a CTA to get in touch."
run_brand "tonys"   "tonyschocolonely.com" "Tony's Chocolonely — bold, colorful chocolate on a mission to end exploitation in cocoa. Loud, playful, righteous. Tell the story: chocolate's hidden cost, the mission, the 5 sourcing principles, the movement, and a CTA to taste it."
run_brand "duolingo" "duolingo.com"      "Duolingo — free, fun, effective language learning. Playful, mascot-driven, a little unhinged. Tell the story: language learning is intimidating, the bite-sized gamified fix, the streak/habit loop, the global community, and a CTA to start a course."

echo; echo "=== DONE — eyeball each preview for C1 (signature color leads) + D2 (chrome variety) ==="
