********************************************************************************
* Test 2: Regression and post-estimation
* Tests: regress, predict, margins, test, stored results panel
********************************************************************************

clear all
set more off

sysuse nlsw88, clear

* Basic OLS
reg wage tenure hours age, robust

* Check stored results panel shows e() scalars
* Should see: N, r2, r2_a, F, etc.

* Post-estimation
predict yhat, xb
predict resid, residuals

* Margins
margins, at(tenure=(0 5 10 15 20))

* Test coefficient equality
test tenure = hours

* Multiple specifications
eststo clear
eststo: reg wage tenure, robust
eststo: reg wage tenure hours, robust
eststo: reg wage tenure hours age i.race, robust

* Display results
di "N = " e(N)
di "R-squared = " %6.4f e(r2)
