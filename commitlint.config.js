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
  // failOnWarnings preservation: CI previously ran wagoid/commitlint-github-action
  // with failOnWarnings: true, so warning-severity findings failed the gate. The
  // direct CLI has no failOnWarnings flag; body-leading-blank and
  // footer-leading-blank are the only warning-severity rules in
  // @commitlint/config-conventional, so promote them to errors to keep the gate
  // equally strict.
  rules: {
    "body-leading-blank": [2, "always"],
    "footer-leading-blank": [2, "always"],
  },
};
