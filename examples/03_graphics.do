********************************************************************************
* Test 3: Graphics
* Tests: scatter, histogram, twoway, graph export, plot viewer navigation
********************************************************************************

clear all
set more off

sysuse auto, clear

* Scatter plot — should appear in plot viewer
scatter price mpg
graph export "test_plot0.png", replace width(1200)

* Histogram — plot viewer should show 2/2, back arrow works
histogram mpg, normal
graph export "test_plot1.png", replace width(1200)

* Two-way with multiple elements
twoway ///
    (scatter price mpg if foreign == 0, mcolor(blue)) ///
    (scatter price mpg if foreign == 1, mcolor(red)) ///
    (lfit price mpg, lcolor(black) lwidth(medium)), ///
    legend(order(1 "Domestic" 2 "Foreign" 3 "Fitted")) ///
    title("Price vs. MPG by Origin") ///
    graphregion(color(white))

graph export "test_plot2.png", replace width(1200)
    
* Box plot
graph box price, over(foreign) ///
    title("Price Distribution by Origin") ///
    graphregion(color(white))

graph export "test_plot3.png", replace width(1200)
