# Spec Delta

## ADDED Requirements

### Requirement: Recover from code replaced by a deploy

When a navigation fails because the code of the target page cannot be loaded (the browser reports a failed dynamic import), the portal SHALL reload itself at the target route, so the current build is used. It SHALL reload at most once within 10 seconds; a failure within 10 seconds of such a reload SHALL be left to surface as an error, so a chunk that is really broken does not reload in a loop. Other navigation errors SHALL NOT cause a reload.

#### Scenario: Tab open across a deploy
- **WHEN** a tab loaded before a deploy navigates to `Chat`, whose old chunk no longer exists
- **THEN** the portal reloads at `/chat` and shows the Chat page from the new build

#### Scenario: Broken chunk
- **WHEN** the reloaded page's chunk fails to load again within 10 seconds
- **THEN** the portal does not reload again and the error surfaces as before

#### Scenario: Other errors
- **WHEN** a navigation fails for another reason, such as a guard throwing
- **THEN** the portal does not reload
