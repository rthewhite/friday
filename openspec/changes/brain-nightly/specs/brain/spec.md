# Spec Delta

## MODIFIED Requirements

### Requirement: Every change is recorded as a revision

Every change to a page SHALL record a revision holding the full name, type, aliases and body after the change, the author (`system`, `user`, `remember`, `extraction` or `consolidation`), the revision it was based on, the source conversation ids when known, an optional note, and its time. A page's revisions SHALL be kept until the page is purged. Saving with a base revision that is no longer the page's current revision SHALL be refused with code `stale`, returning the current page. Revision ids SHALL increase with every revision written across the whole brain and SHALL never be reused, including after a purge deleted the newest revisions, so that "revisions since id N" never misses a write.

#### Scenario: Edit in the portal
- **WHEN** the user saves a page in the portal
- **THEN** a revision with author `user` and the full new body is recorded, based on the revision the user opened

#### Scenario: Concurrent change
- **WHEN** the user opened a page at revision 4, `brain_remember` then appended to it (revision 5), and the user saves based on 4
- **THEN** the save is refused with `stale` and the response carries revision 5

#### Scenario: Ids after a purge
- **WHEN** the newest revisions, up to id 120, belonged to a page that is then purged, and another page is saved
- **THEN** the new revision's id is greater than 120
