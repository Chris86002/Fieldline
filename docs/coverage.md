# Fieldline coverage by state

You can move the map anywhere in the 50 states and DC, including Alaska and Hawaii. **Nationwide navigation does not mean nationwide data.** This page lists, for each state, which hunting layers Fieldline actually has. It mirrors the register in `src/features/catalog/coverage-data.ts`; change both together.

Checked 2026-10-13. Territories are not listed yet.

## What the statuses mean

- **available**: a source integrated in Fieldline covers this state. The provider id is in brackets; see `docs/data-sources.md` for its terms and limits.
- **partial**: a source covers only some of the state or some of the fields. (No entry uses this today.)
- **unavailable**: Fieldline has no source for this layer here. A blank map in an unavailable layer tells you nothing. It does not mean public land, private land, open access or closed access.
- **unknown**: not determined yet. The app reports this for an area that has no entry here.
- **stale**: the last good copy is older than its refresh policy. (Runtime only; this table never says stale.)

## The layers

- **Land management** (`blm-sma`): the BLM Surface Management Agency map. It shows which agency manages the surface. It is not parcel ownership and not permission to hunt or enter.
- **Hunt units**: Arizona (`azgfd-gmu`, Arizona Game and Fish) and Idaho (`idfg-gmu`, Idaho Fish and Game) only. Unit lines are for reference, not the legal description. Everywhere else, use the state wildlife agency's maps.
- **Parcels**: no parcel or owner source anywhere yet.
- **Access**: no access, closure or road-status source anywhere yet. Check with the land manager.
- **Legal hours**: Fieldline doesn't hold verified legal shooting-hour rules anywhere. Sunrise and sunset are astronomy only; check the agency for legal hours.

## Agency links

Each link returned HTTP 200 after redirects on 2026-10-13 and is the agency's own site. "Not verified" means every automated request got a bot-check page (HTTP 403), so Fieldline leaves the link out rather than guess. The New Jersey link answered 200 but behind a bot-check page; its address is where the agency's old domain (njfishandwildlife.com) redirects.

## Table

| State | Land management | Hunt units | Parcels | Access | Legal hours | Agency |
| --- | --- | --- | --- | --- | --- | --- |
| Alabama (AL) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Alabama Department of Conservation and Natural Resources](https://www.outdooralabama.com/) |
| Alaska (AK) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Alaska Department of Fish and Game](https://www.adfg.alaska.gov/) |
| Arizona (AZ) | available (blm-sma) | available (azgfd-gmu) | unavailable | unavailable | unavailable | not verified |
| Arkansas (AR) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Arkansas Game and Fish Commission](https://www.agfc.com/) |
| California (CA) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [California Department of Fish and Wildlife](https://wildlife.ca.gov/) |
| Colorado (CO) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Colorado Parks and Wildlife](https://cpw.state.co.us/) |
| Connecticut (CT) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Connecticut Department of Energy and Environmental Protection](https://portal.ct.gov/deep) |
| Delaware (DE) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Delaware Division of Fish and Wildlife](https://dnrec.delaware.gov/fish-wildlife/) |
| District of Columbia (DC) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [District of Columbia Department of Energy and Environment](https://doee.dc.gov/) |
| Florida (FL) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Florida Fish and Wildlife Conservation Commission](https://myfwc.com/) |
| Georgia (GA) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Georgia Department of Natural Resources, Wildlife Resources Division](https://georgiawildlife.com/) |
| Hawaii (HI) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Hawaii Division of Forestry and Wildlife](https://dlnr.hawaii.gov/dofaw/) |
| Idaho (ID) | available (blm-sma) | available (idfg-gmu) | unavailable | unavailable | unavailable | [Idaho Department of Fish and Game](https://idfg.idaho.gov/) |
| Illinois (IL) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Illinois Department of Natural Resources](https://dnr.illinois.gov/) |
| Indiana (IN) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Indiana Department of Natural Resources, Division of Fish and Wildlife](https://www.in.gov/dnr/fish-and-wildlife/) |
| Iowa (IA) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Iowa Department of Natural Resources](https://www.iowadnr.gov/) |
| Kansas (KS) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Kansas Department of Wildlife and Parks](https://www.ksoutdoors.gov/) |
| Kentucky (KY) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Kentucky Department of Fish and Wildlife Resources](https://fw.ky.gov/) |
| Louisiana (LA) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Louisiana Department of Wildlife and Fisheries](https://www.wlf.louisiana.gov/) |
| Maine (ME) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Maine Department of Inland Fisheries and Wildlife](https://www.maine.gov/ifw/) |
| Maryland (MD) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Maryland Department of Natural Resources](https://dnr.maryland.gov/) |
| Massachusetts (MA) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Massachusetts Division of Fisheries and Wildlife](https://www.mass.gov/orgs/division-of-fisheries-and-wildlife) |
| Michigan (MI) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Michigan Department of Natural Resources](https://www.michigan.gov/dnr) |
| Minnesota (MN) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Minnesota Department of Natural Resources](https://www.dnr.state.mn.us/) |
| Mississippi (MS) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Mississippi Department of Wildlife, Fisheries, and Parks](https://www.mdwfp.com/) |
| Missouri (MO) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Missouri Department of Conservation](https://mdc.mo.gov/) |
| Montana (MT) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Montana Fish, Wildlife & Parks](https://fwp.mt.gov/) |
| Nebraska (NE) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | not verified |
| Nevada (NV) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Nevada Department of Wildlife](https://www.ndow.org/) |
| New Hampshire (NH) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [New Hampshire Fish and Game Department](https://www.wildlife.nh.gov/) |
| New Jersey (NJ) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [New Jersey Division of Fish and Wildlife](https://dep.nj.gov/njfw/) |
| New Mexico (NM) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [New Mexico Department of Wildlife](https://wildlife.dgf.nm.gov/) |
| New York (NY) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [New York State Department of Environmental Conservation](https://dec.ny.gov/) |
| North Carolina (NC) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [North Carolina Wildlife Resources Commission](https://www.ncwildlife.gov/) |
| North Dakota (ND) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [North Dakota Game and Fish Department](https://gf.nd.gov/) |
| Ohio (OH) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Ohio Department of Natural Resources, Division of Wildlife](https://ohiodnr.gov/discover-and-learn/safety-conservation/about-ODNR/wildlife) |
| Oklahoma (OK) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Oklahoma Department of Wildlife Conservation](https://www.wildlifedepartment.com/) |
| Oregon (OR) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Oregon Department of Fish and Wildlife](https://www.dfw.state.or.us/) |
| Pennsylvania (PA) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Pennsylvania Game Commission](https://www.pa.gov/agencies/pgc) |
| Rhode Island (RI) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | not verified |
| South Carolina (SC) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [South Carolina Department of Natural Resources](https://www.dnr.sc.gov/) |
| South Dakota (SD) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [South Dakota Game, Fish and Parks](https://gfp.sd.gov/) |
| Tennessee (TN) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Tennessee Wildlife Resources Agency](https://www.tn.gov/twra) |
| Texas (TX) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Texas Parks and Wildlife Department](https://tpwd.texas.gov/) |
| Utah (UT) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Utah Division of Wildlife Resources](https://wildlife.utah.gov/) |
| Vermont (VT) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Vermont Fish and Wildlife Department](https://vtfishandwildlife.com/) |
| Virginia (VA) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Virginia Department of Wildlife Resources](https://dwr.virginia.gov/) |
| Washington (WA) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Washington Department of Fish and Wildlife](https://wdfw.wa.gov/) |
| West Virginia (WV) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [West Virginia Division of Natural Resources](https://wvdnr.gov/) |
| Wisconsin (WI) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Wisconsin Department of Natural Resources](https://dnr.wisconsin.gov/) |
| Wyoming (WY) | available (blm-sma) | unavailable | unavailable | unavailable | unavailable | [Wyoming Game and Fish Department](https://wgfd.wyo.gov/) |

## Discovery boxes

Each state has one or more rough bounding boxes (Census TIGERweb state extents, 2026-10-13, rounded outward). Fieldline uses them only to decide which sources to ask for the current view. Neighboring boxes overlap, so a point near a border can match two or more states; the boxes are never used to decide which state you are in. Alaska has two boxes because the Aleutian Islands cross the 180° meridian.
