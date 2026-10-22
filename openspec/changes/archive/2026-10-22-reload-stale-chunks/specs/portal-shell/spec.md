# Spec Delta

## ADDED Requirements

### Requirement: Recover from code replaced by a deploy

When a navigation fails because the code of the target page cannot be loaded (the browser reports a failed dynamic import, or a page's stylesheet cannot be preloaded), the portal SHALL reload itself at the target route, so the current build is used. It SHALL reload for a given target at most once until a navigation succeeds again; a target that fails again after its reload SHALL be left to surface as an error, so a page that is really broken does not reload in a loop, however long the reload takes. When the browser does not allow the portal to record that reload, it SHALL NOT reload. Other navigation errors SHALL NOT cause a reload. Every navigation error that does not lead to a reload SHALL still be reported in the browser console. When the first page after loading the portal cannot be shown, the shell (sidebar and navigation) SHALL still be shown.

#### Scenario: Tab open across a deploy
- **WHEN** a tab loaded before a deploy navigates to `Chat`, whose old chunk no longer exists
- **THEN** the portal reloads at `/chat` and shows the Chat page from the new build

#### Scenario: Broken chunk
- **WHEN** the reloaded page's chunk fails to load again
- **THEN** the portal does not reload again, the error is reported in the console, and the sidebar is shown

#### Scenario: A later deploy
- **WHEN** a reload brought a tab to `/chat` successfully and a later deploy again replaces the Chat chunk under that tab
- **THEN** the next navigation to `Chat` reloads again

#### Scenario: Other errors
- **WHEN** a navigation fails for another reason, such as a guard throwing
- **THEN** the portal does not reload and the error is reported in the console
