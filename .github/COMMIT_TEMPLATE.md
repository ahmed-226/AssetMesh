# Commit template — AssetMesh
# Update the {…} placeholders, then delete every comment line (all lines
# starting with #) before saving. The issue number comes from `gh issue list`
# (milestone M{n} = that milestone's GitHub issue).

# 1. Title — one logical change. `type` (lowercase): feat · fix · docs · test ·
#    refactor · perf · chore · build. `scope` = the milestone (m0–m8) when the
#    change is milestone work, else omit. Subject: imperative, ≤72 chars, no
#    trailing period.
{type}({m-scope}): {imperative subject ≤72 chars}

# 2. Closes the milestone issue — GitHub auto-closes it on merge.
Closes #{issue_id}

# 3. Body — only if the subject can't carry the reason. Explain WHY, not what.
{short paragraph describing the change, why it's shaped this way, and any
deviations from the plan}

# 4. Files changed — grouped list, human-readable (a file per line or grouped
#    by concern, as in the M1–M3 commits).
Files changed:
- {path or group}: {one-line why/role if it helps}
- {…}