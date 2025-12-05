# Pull Request Draft: MIT to AGPL-3.0 License Migration

## PR Title
```
chore: migrate from MIT to AGPL-3.0 license
```

## PR Body

This changes the Epicenter project license from MIT to AGPL-3.0 as the first step toward implementing the dual-licensing model.

As I mentioned in [issue #792](https://github.com/EpicenterHQ/epicenter/issues/792), I've been thinking about how to make Epicenter sustainable while staying true to our commitment to transparency and open source. After considering several options, a dual-license approach feels like the most honest path forward.

The AGPL-3.0 license keeps the project completely free for anyone building open-source software. The copyleft nature means that improvements stay in the commons, benefiting the entire community. At the same time, companies that want to incorporate Epicenter into closed-source products can purchase a commercial license to do so without the copyleft obligations.

This is the same model used by Cal.com, dub.sh, and other successful open-source projects that balance community support with business sustainability.

This PR specifically:
- Replaces the LICENSE file with the full AGPL-3.0 license text
- Updates the license field in package.json from "ISC" to "AGPL-3.0"
- Updates the README.md license badge and footer section
- Updates copyright year to 2023-2025

For open-source contributors and users, nothing changes: you can still use, modify, and distribute the code freely. You're always free to self-host this for personal use without sharing your changes. The key difference from MIT is that if you distribute the software or run it as a network service for others, modifications must be shared under the same license. This aligns perfectly with our values of transparency and data ownership.

The commercial licensing terms and infrastructure will be set up separately. This PR focuses solely on establishing AGPL-3.0 as the open-source license.

---

## Notes for Review

### What Changes
- License becomes copyleft (modifications must be shared)
- Network use triggers source disclosure (key AGPL feature)
- Commercial closed-source use requires separate license

### What Doesn't Change
- Open-source contributors can use freely
- Core philosophy remains the same
- Codebase stays fully open source
- No impact on existing users

### Files Modified
- LICENSE: Full AGPL-3.0 text
- package.json: License field updated
- README.md: Badge and license section updated
- Any other files referencing the license

### Considerations
- Dependency license compatibility (needs verification)
- Contributor awareness of license change
- Future: commercial licensing setup

---

## Discord Announcement (Post-Merge)

Hey everyone! Just merged a change to migrate Epicenter from MIT to AGPL-3.0.

As I mentioned in [#792](https://github.com/EpicenterHQ/epicenter/issues/792), this is the first step toward a dual-licensing model: fully open source for community use, with commercial licensing available for closed-source products.

For contributors and users, nothing changes. The code stays open and free. AGPL-3.0 just ensures improvements stay in the commons, which fits our transparency values.

If there's enough demand down the road, I'm open to keeping individual apps like Whispering as MIT while keeping the core libraries as AGPL. For now, everything is AGPL-3.0.

Questions or concerns? Full context in the issue above.
