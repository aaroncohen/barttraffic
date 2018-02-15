Bart Traffic
------------

RECENT VERSIONS OF CHROME ONLY, uses ECMAScript 6 features without translation/polyfill.

Live page: <https://aaroncohen.github.io/barttraffic/>

A visualization tool for the BART (Bay Area Rapid Transit) API that shows train delays as "Traffic" between stations,
similar to the way that Google Maps shows vehicular traffic.

If all of the lines are green, great! No traffic!

This was written as an opportunity to learn ECMAScript 6 Javascript. It is entirely client side, and hammers the BART 
API a bit when pulling down information about the location of every station as well as estimated train arrival times.
This was somewhat quickly thrown together, and was my first attempt at semi functional promise-based javascript.

TODO:
* I need to offset the lines different directions of train traffic so that you can see them both...right now I've added
 arrow ends to make things a little more clear as to which end is having the slowdown.
* In the repo I've got a GeoJSON representation of the actual track routes -- I'd like to use those rather than just
drawing naive lines between the stations.
* The page intermittently fails to load, saying that it can't find the initMap function...and *always* fails when trying
to load in Firefox. Not sure what's going on with this.
