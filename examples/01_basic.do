********************************************************************************
* Test 1: Basic data loading, manipulation, and descriptives
* Tests: sysuse, gen, replace, summarize, tabulate, browse, describe
********************************************************************************

clear all
set more off

* Load built-in dataset
sysuse auto, clear

* Check describe and summarize
describe
summarize price mpg weight

* Create variables
gen price_k = price / 1000           // price in thousands
gen expensive = (price > 6000)       // binary indicator
replace expensive = . if missing(price)

* Labels
label variable price_k "Price (thousands $)"
label define yesno 0 "No" 1 "Yes"
label values expensive yesno

* Tabulation
tabulate expensive
tabulate foreign expensive, chi2

* Browse the data (use interactively or via Cmd+Shift+D — not in nested do-files)
* browse make price mpg expensive in 1/20
