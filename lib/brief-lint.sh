# Brief lint shared by omp-tab.sh and opencode-tab.sh. Sourced, not run: each
# function prints the offending line numbers of the brief, comma-separated, and
# prints nothing when the brief is clean. The caller words the refusal.

# A bare `#N` placeholder outside backticks or a fenced block: a tab copies it
# into a commit subject or PR body (this repo's 2e48705 shipped `(#N)`).
brief_placeholder_lines() {
  awk '/^[[:space:]]*```/ { f = !f; next } f { next }
    { l = $0; gsub(/`[^`]*`/, "", l); if (l ~ /(^|[^[:alnum:]_&])#(N|NN|NNN|n|<n>)([^[:alnum:]_]|$)/) { printf "%s%d", s, NR; s = "," } }' "$1"
}

# A line that spells out a whole Co-Authored-By trailer (name and <email>)
# without a negation before it: the box's commit hooks refuse AI authorship
# trailers, so a tab told to add one fails its commit (agent-config#1007 row 1:
# two briefs asked for it, and lefthook's ai-authorship check refused both
# tabs' commits). Backticks and fences do not excuse it; a quoted trailer in a
# brief reads as the one to add. A bare mention is left alone: audit briefs
# grep commits for the word, and a regex naming it is not an instruction.
brief_trailer_lines() {
  awk '{ l = tolower($0); if (!match(l, /co-authored-by:[ \t]*[^<]+<[^>@ ]+@[^> ]+>/)) next
    p = substr(l, 1, RSTART - 1)
    if (p ~ /(^|[^[:alnum:]])(not|never|no|without|don.t)([^[:alnum:]]|$)/) next
    printf "%s%d", s, NR; s = "," }' "$1"
}
