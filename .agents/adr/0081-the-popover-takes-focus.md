# 81. The popover takes focus

2026-08-10 · relates to 72; relates to 75

**Context:** the popover opened dark and stayed on screen over other applications, both because an accessory app's activation was not landing before the window was shown — an inactive window renders its material desaturated and receives none of the events a transient popover dismisses itself on, so the two symptoms were one bug wearing two faces. **Decision:** opening the popover genuinely activates the app and makes the popover's window key, and the app closes the popover when it resigns active. **Consequences:** whatever window the reader was in visibly goes inactive for as long as the popover is up, which is the price of a popover that renders correctly, dismisses on an outside click and can be driven from the keyboard at all; the alternative — a background popover kept alive by a global event monitor — was rejected because it buys the missing focus back by hand and still cannot make the window key.
