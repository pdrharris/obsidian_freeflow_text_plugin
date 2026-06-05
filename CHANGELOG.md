# Changelog

## Unreleased

### Fixed
- Improved Apple Pencil stroke-start reliability on iPad by suppressing default touch gesture handling while pointer-driven pen strokes are active in the drawer.
- Added drawer-level touch-action and user-selection guards to reduce Safari/iOS gesture interference with rapid consecutive starts.

### Changed
- Reduced pencil timing summary output to a minimal health view for day-to-day use while retaining internal counters for deeper investigations when needed.
