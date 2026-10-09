// Dependabot's bump subjects ("Bump ws from 8.19.0 to 8.20.1 in /habot/server")
// are sentence-case, which @commitlint/config-conventional's subject-case rule
// rejects — so every dependabot PR failed the commitlint job. Pass through
// commits in dependabot's exact bump format instead of weakening subject-case
// for human commits.
const isDependabotBump = (commit) =>
  /^build\((?:deps|deps-dev)\): Bump .+ from \S+ to \S+ in \S+/.test(commit);

export default {
  extends: ["@commitlint/config-conventional"],
  ignores: [isDependabotBump],
};
