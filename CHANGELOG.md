# Changelog

All notable changes to Codex Monitor Bridge are documented here.

## 2026-06-15 - Quota-Aware Monitor Delivery

### Added

- Added Codex usage and rate-limit preflight before monitor events are sent to
  app-server.
- Added deferred delivery when Codex usage is temporarily unavailable and the
  reported reset time is inside the configured waiting window.
- Added dashboard states for delayed delivery, usage limits, and quota check
  failures.
- Added daemon options for tuning quota behavior:
  `--app-server-quota-max-defer-sec`,
  `--app-server-quota-resume-buffer-sec`,
  `--app-server-quota-min-primary-remaining-percent`,
  `--app-server-quota-min-secondary-remaining-percent`, and
  `--app-server-quota-min-individual-remaining-percent`.

### Fixed

- Fixed monitor events being retried repeatedly after app-server returned
  `usageLimitExceeded` or `willRetry:false`.
- Fixed non-retryable app-server errors being misclassified as empty assistant
  replies.
- Reduced the chance that usage-limit failures pollute the target Codex session
  with duplicate monitor messages.

### Maintenance

- Tracked the issue as
  [#2](https://github.com/YurainSoon/codex-monitor-bridge/issues/2).
- Implemented the code fix in commit `6960445`.
