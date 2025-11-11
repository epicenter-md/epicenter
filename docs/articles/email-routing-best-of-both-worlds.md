# How I Kept Wildcard Email Routing While Adding Google Workspace

I had the perfect email setup with Cloudflare Email Routing. Any email sent to `*@epicenter.so` would forward to my personal inbox. `hello@epicenter.so`, `random-service-signup@epicenter.so`, `newsletter-123@epicenter.so` — they all just worked. It was beautiful.

Then I needed a professional email address. Google Workspace seemed like the obvious choice for `braden@epicenter.md`. That's when I hit the MX record wall.

## The Problem

Here's the thing: both Cloudflare Email Routing and Google Workspace need your domain's MX records pointing to their servers. You can't have both. It's one or the other.

But there's another catch I discovered the hard way: **Cloudflare Email Routing doesn't support subdomains** (unless you're on an Enterprise plan). So the common advice of "just use a subdomain" doesn't work. You can't set up email routing on `mail.yourdomain.com` or `notifications.yourdomain.com`. Cloudflare Email Routing only works at the root domain level.

## The Solution: Two Separate Domains

The only real solution is to use two completely separate domains. Not subdomains, but actual different domains.

Now my setup looks like this:
- `epicenter.md` → Google Workspace (for `braden@epicenter.md`)
- `epicenter.so` → Cloudflare Email Routing (for wildcard aliases)

### Setting It Up

1. **Register a second domain**: Get a complementary domain (I chose `.so` to pair with my `.md`)
2. **Configure Google Workspace on your primary domain**: MX records for `epicenter.md` point to Google's servers
3. **Configure Cloudflare Email Routing on your secondary domain**: Set up wildcard forwarding (`*@epicenter.so`)
4. **Keep them completely separate**: Each domain has its own MX records pointing to different services

## What I Use Each For

**Google Workspace (`braden@epicenter.md`)**:
- Professional communication
- Client emails
- Business correspondence
- Resume and business cards

**Cloudflare Email Routing (`*@epicenter.so`)**:
- Service signups
- Newsletter subscriptions
- Testing email flows
- Anything where I want a unique, trackable email address

## The Trade-off

Yes, I need to maintain two domains. That's about $20/year extra for the second domain. But I get to keep both my professional Google Workspace email and my wildcard routing flexibility.

For service signups, I now use addresses like `github@epicenter.so` or `aws@epicenter.so`. They all forward to my personal inbox, and I can still track which service might have leaked my email if spam shows up.

## Why Subdomains Don't Work

I initially tried using subdomains, thinking I could set up `notifications.epicenter.md` for Cloudflare Email Routing. Turns out:

1. Cloudflare Email Routing requires control of the root domain's MX records
2. It doesn't support routing on subdomains for non-Enterprise accounts
3. Even if you manually set MX records on a subdomain, Cloudflare's Email Routing interface won't let you configure it

The only way to have both services is to use completely separate domains.

## Alternative Approaches

If you don't want to maintain two domains, here are your options:

**Option 1: Google Workspace Only**
Give up wildcard routing. Use Google Workspace's alias feature (limited) or create multiple users.

**Option 2: Email Routing Service That Supports Subdomains**
Services like ImprovMX, Forward Email, or SimpleLogin can work with subdomains. You could have:
- `epicenter.md` → Google Workspace
- `mail.epicenter.md` → ImprovMX (or similar service)

**Option 3: Self-Host**
Run your own mail server that can handle subdomain routing. Complex but gives you full control.

## The Bottom Line

If you want the free wildcard email routing from Cloudflare AND professional email from Google Workspace, you need two separate domains. It's not ideal, but it's the only way to get both services working exactly as intended without compromises or paid third-party services.

The $10-15/year for a second domain is worth it for the flexibility and peace of mind. Plus, having a second domain can be useful for other projects, URL shorteners, or domain hacks.