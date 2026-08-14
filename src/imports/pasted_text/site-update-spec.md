CONTYNT — Site Update Spec

This update covers three surfaces and the data flow between them:


Admin Analytics Dashboard (private, just for me)
Creator Portal (where creators claim and submit Reels)
Business Portal (where a business views submitted Reels and chooses a plan)


The core flow: a business signs up → I Approve it in the admin dashboard → it appears as a Feature in every creator's portal → a creator Claims it (in progress) → submits a Reel → I Approve the Reel → it marks Claimed in the creator portal AND appears in that business's portal with metrics and a plan upsell.


1. ADMIN ANALYTICS DASHBOARD (private)

Access


Generate one unique private link I can visit directly with no password.


Top-level analytics


Remove the Total Page Views count.
Remove the Unique Visitors count.
Move Recent Page Views to its own tab I can toggle to, like switching browser tabs.


Creator Sign-Ups


Redesign as a proper admin table/card layout.
Must NOT require horizontal scrolling on mobile. Stack fields vertically into cards on small screens instead of a wide scrolling row.


Business Sign-Ups


Same redesign and same no-horizontal-scroll rule on mobile.
Add an Approve button next to each business.
Add an input field for Payout Range next to each business.
When I click Approve, that business becomes a Feature in the creator portal (see Section 2), showing: Business Name, Address, Category, and the Payout Range I entered. Leave out the task description.


Submitted Reels (NEW section)


New section listing each Reel a creator submitted.
Each submission shows the creator and Reel info.
Add a Fetch button that pulls the Reel's live metrics and updates the record: Reach (if possible), Views, Likes, Comments, Shares, Saves.
Add an Approve button. When clicked:

The matching Feature in the creator portal flips to Claimed (all creators see the same Feature state).
The Reel and its info publish to that business's portal (see Section 3).



After viewing a Reel, two response buttons:

👍 Approve
👎 Report Issue → opens a text field to type and submit a note. Show the response on my analytics page.






2. CREATOR PORTAL

Loading / branding


Page-load screen shows the CONTYNT logo.
Place the word BETA somewhere visible in the portal.


Features list


Real Features appear at the top. These come only from businesses I've Approved in the admin dashboard, showing Business Name, Address, Category, and Payout Range.
Keep exactly 2 fake/sample Features below the real ones, labeled CLAIMED and fully grayed out. Remove all other placeholder features.
All creators must see the same Features in the same state.


Feature card states

Default: shows the business info and a Claim Feature button.

After Claim Feature is clicked (in progress):


Card visibly switches to an "in progress / working on it" state.
Show a map of the business location.
Field to enter the Reel URL.
Instructions: add the business as a collaborator, tag the business, and add their location to the post.
A Submit button.
A countdown timer that conveys urgency but displays NO actual digits/numbers (visual only, e.g. a depleting bar or pulse).
The Claim button becomes an Unclaim button that reverts the card back to default.


After Submit is clicked (pending review):


Card switches to Pending for Review.
Grayed-out / disabled Payout button with a lock icon, and helper text below: "Available after approval".
A blurred IG Reel preview with: soft dark overlay, subtle glow/vignette, and an animated loading state (shimmer or pulsing blur shimmering across the preview).
An animated indicator: pulsing dot, spinning loader, or soft gradient shimmer.


After I Approve the Reel (admin side):


The Feature flips to Claimed in every creator's portal.



3. BUSINESS PORTAL

Access


Each business has a Generate Link button that creates their private portal.
This portal is where they see the Reel(s) submitted for them.


Submitted Reel display (after I Approve in admin)


View Reel button + Reel URL
Post date
Creator username, profile picture, follower count
Metrics: Reach (if possible), Views, Likes, Comments, Shares, Saves
A badge such as "Creator Verified Visit" or "Created from in-person experience."


Plan upsell (below the Reel info)

Header: Keep creating content for your business
Subtext: One Reel gets you started. Consistent creator content keeps your business visible.

Choose your plan — Keep your business active with local creators

🌱 Starter — $59/month
Stay visible with monthly creator content. One local creator features your business each month, posted to their audience and yours.


1 creator Reel per month, sometimes more
Posted by a real local creator to their followers
Collab tag so it appears on your profile too
Your business tagged and location-tagged
Your own dashboard showing each Reel's performance: views, likes, comments, and reach
Fully managed, zero effort on your end
👉 Start Building Presence


⭐ Growth — $99/month (Most Popular)
Consistent local content from multiple creators. Two creators, two audiences, steady local reach all month.


2 creator Reels per month, sometimes more
Posted by local creators to their followers
Collab-tagged to your profile
Variety of creators and styles
Tagged and location-tagged to your business
Dashboard tracking performance across every Reel, side by side
Fully managed, zero effort on your end
👉 Grow My Brand Presence


🔥 Pro — $149/month
Maximum local presence, multiple creators. A steady content engine for businesses serious about local visibility.


4 creator Reels per month, sometimes more
Multiple creators featuring your business
Posted to their audiences, Collab-tagged to yours
Tagged and location-tagged on every post
Priority scheduling and fastest turnaround
Full dashboard with performance trends over time and outreach reach across all your creators
Fully managed end to end
👉 Expand My Reach


Closing line under all plans: Cancel anytime. No contracts.


SHARED RULES


Mobile-first. No horizontal scrolling anywhere; stack into cards on small screens.
The same Feature state is shown to all creators simultaneously