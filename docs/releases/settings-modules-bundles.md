# SSDashboard, settings, modules and plans

_Release date: to be set when this release is published_

Managers can now see and change how the brand works from one settings screen. Each optional part of the app can be switched on or off, and a license file decides which plans your install runs and until when.

## Highlights

- **One settings screen**: Brand, modules and license, automations, policies, catalog, location owner types, and cost rules are all in one place. Every change asks for a reason, and the app keeps a record of who changed what and when.
- **Switch modules off safely**: when a module is off, its pages hide and its scheduled and queued work stops, so nothing is left running half way. Turning it back on is safe. Core parts of the app cannot be switched off.
- **License file per install**: a signed license file says which plans (Warehouse, Operations) the install holds and until when. A Warehouse plan can carry an end date for a pilot or trial.
- **Early warning before a plan ends**: the app warns managers 30, 14, and 7 days before an Operations plan ends, then gives 14 days of grace. After that comes a wind down. Cash for shipments already with Bosta is still followed and closed, so the last month can close. Core work keeps running after an Operations plan ends.
- **Automations stay off until you turn them on**: each step that acts outside the app (creating Bosta shipments, refunds, writing to Shopify, sending customer messages) has its own switch. Every switch is off on a new install. A step only acts on what happens after you switch it on.
- **Owner terms you can edit**: the terms for each location owner type can be changed with a reason. Stock a partner or a customer holds can never be offered for sale online.
- **Cost rules with history**: cost rules are kept with their history. A rule that would change a locked period needs a written reason.

## Improvements

- Staff whose work stops when a module is off see a short, neutral notice. Commercial terms are not shown to them.
- The screens show the plan each setting needs, such as "needs the Operations plan", when that plan is not held.
- A damaged stored setting is flagged for a manager to repair. For the lock date and the document numbering, the work that setting guards stops until it is repaired, instead of running without its guard.

## Breaking changes

- **An install without a valid license runs only the core parts.** Operations and Warehouse features stay off until a valid license file is installed. Ask your technical contact to check the license section of the settings screen after the upgrade.
- **Production installs cannot take a license yet.** This release trusts only a development key, and a production build refuses every license until the owner's production keys are added in a later release. Until then a production install runs core parts only. The development key is for development and testing only.

## Upgrade notes

1. Run the upgrade as usual. The migration step applies database migrations `0011` and `0012` on its own. They check the three existing location owner type rows against the new rules. If a row breaks a rule, the upgrade stops, so tell your technical contact before retrying.
2. Ask your technical contact to place the license file for this install and set its path, then open the settings screen and check the Modules and license section.
3. Review the Automations section. Every automation starts off. Turn on only the ones you want, after you read what each one will start doing for the brand.
4. Review the Brand section, including the time zone, the operating day cutoff, and the inventory lock date. A change to the day cutoff or the time zone does not restate days already recorded, but the day of the change becomes longer or shorter.

## Not in this release

- Online sales do not reduce stock on the install until a stock out source is turned on. The Shopify stock push waits for one, and the stock pages say so.
- The partner portal, partner settlement, purchasing, and production come in later releases.
