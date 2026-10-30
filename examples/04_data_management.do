********************************************************************************
* Test 4: Data management
* Tests: merge, reshape, collapse, preserve/restore, tempfile
********************************************************************************

clear all
set more off

sysuse auto, clear

* --- Collapse ---
preserve
  collapse (mean) price mpg (count) n=price, by(foreign)
  list
restore

* --- Reshape ---
preserve
  keep make price mpg weight
  gen id = _n
  reshape long, i(id) // this will error — intentional test of error display
restore

* --- Preserve/Restore ---
preserve
  drop if foreign == 1
  count
  di "Domestic only: " _N " observations"
restore
di "All data back: " _N " observations"

* --- Duplicates ---
duplicates report make

* --- Sort ---
gsort -price
list make price in 1/5

* Browse after manipulation (use interactively or via Cmd+Shift+D)
* browse
