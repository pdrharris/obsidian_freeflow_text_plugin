# Regression Checklist

Use this quick pass before release when touching input, pointer, or touch code.

## Pencil Reliability (iPad)
- Run a 20-stroke Apple Pencil quick-start test in the drawer.
- Confirm all intended starts are captured with no repeated first-attempt misses.
- Confirm no connector artifacts appear between separate strokes.
- Confirm rapid lift-and-restart strokes remain stable.

## Interaction Safety
- Confirm drawer does not trigger page scroll/selection/callout while drawing.
- Confirm finger touch does not interfere with active pencil strokes.

## Editor Behavior
- Confirm newline insertion behavior is unchanged.
- Confirm caret/cursor placement stays correct after drawing and newline actions.
- Confirm erase-last-stroke behavior still works as expected.

## Build Health
- Run npm run build.
- Run npm run lint.
