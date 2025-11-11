# Why I Use a Second Domain for Email Aliases (Not a Subdomain)

When setting up email routing for a new domain, here's my advice: don't try to use subdomains for aliases with Cloudflare Email Routing. It doesn't work. You need a second domain.

I learned this the hard way.

## The Subdomain Myth

You'll find advice all over the internet saying "just use a subdomain for your email aliases." Use `mail.yourdomain.com` for forwarding and keep `yourdomain.com` for professional email.

Sounds perfect. Except it doesn't work with Cloudflare Email Routing.

**Cloudflare Email Routing only works on root domains** (unless you pay for an Enterprise plan). You can't configure `notifications.yourdomain.com` or `mail.yourdomain.com` for email routing. The service needs control of the root domain's MX records, period.

## The Real Solution: Two Domains

The actual strategy that works:
- `yourdomain.com` → Your professional email (Google Workspace, Fastmail, etc.)
- `yourdomain.so` → Your aliases and forwarding (Cloudflare Email Routing)

Yes, you need to buy and maintain a second domain. That's about $10-15/year. But it's the only way to get both professional email and free wildcard forwarding with Cloudflare.

## My Setup

I use this separation:
- `epicenter.md` → Professional email via Google Workspace
- `epicenter.so` → All my aliases, forwarders, and service signups via Cloudflare

When I sign up for services:
- GitHub: `github@epicenter.so`
- Netflix: `netflix@epicenter.so`
- Random newsletter: `news-oct-2024@epicenter.so`

They all forward to my personal inbox, and I can track exactly who's emailing me (or who leaked my email).

## Why Not Just Pick One Service?

**Option 1: Google Workspace Only**
You lose wildcard email routing. You're limited to 30 email aliases (or whatever your plan allows). Creating unique emails for every service becomes a hassle.

**Option 2: Cloudflare Email Routing Only**
You can't send email properly. It's receive-only. No professional `you@yourdomain.com` address for your resume.

**Option 3: Other Services**
Services like ImprovMX, Forward Email, or SimpleLogin *can* work with subdomains. But they're either paid or have significant limitations on the free tier. If you're going the paid route, this could work:
- `yourdomain.com` → Google Workspace
- `mail.yourdomain.com` → ImprovMX (or similar)

But if you want the completely free Cloudflare Email Routing, you need two domains.

## Future Flexibility

Having two domains gives you complete flexibility:

1. **Switch professional providers easily**: Move from Google Workspace to Fastmail to ProtonMail without touching your aliases
2. **Switch forwarding services easily**: Move from Cloudflare to another service without affecting professional email
3. **Segregate purposes clearly**: Professional vs. personal/services
4. **Domain redundancy**: If one domain has issues, you have a backup

## The Domain Cost Perspective

You're probably paying $10/month for Google Workspace. The extra $15/year for a second domain is negligible. Think of it as insurance for your email setup.

Plus, that second domain can serve other purposes:
- URL shortener
- Development/staging sites
- Project-specific uses
- Domain hacks

## Choosing Your Second Domain

Pick complementary TLDs:
- `.com` + `.net`
- `.md` + `.so` (what I use)
- `.com` + `.io`
- `.org` + `.dev`

Keep the base name the same for brand consistency. The different TLD makes it clear they serve different purposes.

## Initial Setup Strategy

If you're just starting:

1. **Buy both domains immediately**: Even if you don't need professional email yet
2. **Set up Cloudflare Email Routing on the secondary domain**: Start using it for all service signups
3. **Keep the primary domain clean**: When you eventually need professional email, it's ready
4. **Document your setup**: Keep track of which domain serves which purpose

## Common Objections Addressed

"Can't I just use Gmail with a custom domain?"

Gmail doesn't offer this anymore for personal use. You need Google Workspace, which costs money.

"What about using one domain for both with time-based switching?"

You can't have both services active simultaneously. You'd have to keep switching MX records, losing emails in the process.

"This seems overly complex."

It's actually simpler than trying to make one domain do everything. Clear separation, no compromises, everything just works.

## The Bottom Line

Subdomains for email routing sound great in theory but don't work with Cloudflare Email Routing in practice. You need two separate domains. It's a small price to pay for a clean, flexible email setup that gives you both professional email and unlimited aliases.

Don't try to force one domain to do everything. Get a second domain, set it up right from the start, and enjoy the best of both worlds.