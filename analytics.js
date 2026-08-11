/*
  QuorumCivic store-link attribution.

  Carries the landing page's campaign parameters through to the App Store and
  Google Play links, and mirrors the same values onto a PostHog event so all
  three reports share one join key.

  Join key is campaign_token, for example "web-hero-reddit":
    Apple        ct=<token>           App Store Connect > App Analytics > Campaigns
    Google Play  utm_content=<token>  inside the install referrer string
    PostHog      campaign_token       property on the store_link_click event

  Links carry a working ...-direct token in their markup, so the tokens stay
  valid if this script never runs. The script only upgrades them in place.
*/
(function () {
  'use strict';

  var SITE_SOURCE = 'quorumcivic.app';
  var SITE_MEDIUM = 'website';
  var STORAGE_KEY = 'qc_attribution';
  var DEFAULT_CHANNEL = 'direct';
  var TOKEN_MAX = 40; // Apple truncates campaign tokens past 40 characters
  var VALUE_MAX = 120;

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

  // Ad-platform click ids, used to name the channel when no utm_source is set.
  var CLICK_IDS = {
    gclid: 'google-ads',
    gbraid: 'google-ads',
    wbraid: 'google-ads',
    fbclid: 'meta',
    ttclid: 'tiktok',
    msclkid: 'bing-ads',
    twclid: 'x'
  };

  function slug(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // Pull campaign signal off the current URL, falling back to the referring host.
  function readLanding() {
    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (e) {
      return null;
    }

    var attribution = {};
    var found = false;

    UTM_KEYS.forEach(function (key) {
      var value = params.get(key);
      if (value) {
        attribution[key] = value.slice(0, VALUE_MAX);
        found = true;
      }
    });

    for (var id in CLICK_IDS) {
      if (Object.prototype.hasOwnProperty.call(CLICK_IDS, id) && params.get(id)) {
        attribution.click_id_type = id;
        if (!attribution.utm_source) attribution.utm_source = CLICK_IDS[id];
        found = true;
        break;
      }
    }

    if (found) return attribution;

    // No tagged link, so fall back to the referrer. Same-host navigation between
    // our own pages is not a new touch and is ignored here.
    var host = '';
    try {
      host = new URL(document.referrer).hostname.replace(/^www\./, '');
    } catch (e) {
      return null;
    }
    if (!host || host === window.location.hostname) return null;

    return { utm_source: host, utm_medium: 'referral', referrer_host: host };
  }

  function load() {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function save(attribution) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(attribution));
    } catch (e) {
      // Private browsing or storage disabled. In-memory value still works for this page.
    }
  }

  // Last non-direct touch wins. A tagged landing overwrites whatever the session
  // held; an untagged page keeps the stored value so the signal survives an
  // internal hop from the landing page to a page holding a store link.
  function resolve() {
    var landing = readLanding();
    if (landing) {
      save(landing);
      return landing;
    }
    var stored = load();
    if (stored) return stored;

    var fallback = { utm_source: DEFAULT_CHANNEL };
    save(fallback);
    return fallback;
  }

  function channelOf(attribution) {
    return slug(attribution.utm_source) || DEFAULT_CHANNEL;
  }

  function buildToken(placement, attribution) {
    var parts = ['web', slug(placement) || 'unknown', channelOf(attribution)];
    var campaign = slug(attribution.utm_campaign);
    if (campaign && campaign !== parts[2]) parts.push(campaign);
    return parts.join('-').slice(0, TOKEN_MAX).replace(/-+$/, '');
  }

  function decorate(link, attribution) {
    var store = link.getAttribute('data-store');
    var token = buildToken(link.getAttribute('data-placement'), attribution);
    var url;

    try {
      url = new URL(link.href);
    } catch (e) {
      return null;
    }

    if (store === 'app_store') {
      url.searchParams.set('ct', token);
    } else if (store === 'google_play') {
      // Play takes one referrer value holding an encoded utm string. The site is
      // the source of the store visit; what drove the visit to the site rides
      // along in utm_campaign.
      var referrer = new URLSearchParams();
      referrer.set('utm_source', SITE_SOURCE);
      referrer.set('utm_medium', SITE_MEDIUM);
      referrer.set('utm_campaign', slug(attribution.utm_campaign) || channelOf(attribution));
      referrer.set('utm_content', token);
      url.searchParams.set('referrer', referrer.toString());
    } else {
      return null;
    }

    link.href = url.toString();
    return token;
  }

  function track(link, token, attribution) {
    if (!window.posthog || typeof window.posthog.capture !== 'function') return;

    window.posthog.capture(
      'store_link_click',
      {
        store: link.getAttribute('data-store'),
        placement: link.getAttribute('data-placement'),
        campaign_token: token,
        channel: channelOf(attribution),
        landing_utm_source: attribution.utm_source || null,
        landing_utm_medium: attribution.utm_medium || null,
        landing_utm_campaign: attribution.utm_campaign || null,
        landing_utm_content: attribution.utm_content || null,
        landing_utm_term: attribution.utm_term || null,
        landing_click_id_type: attribution.click_id_type || null,
        landing_referrer_host: attribution.referrer_host || null,
        store_url: link.href
      },
      // The click navigates away, so hand the event off in a way that survives unload.
      { send_instantly: true, transport: 'sendBeacon' }
    );
  }

  function init() {
    var attribution = resolve();
    var links = document.querySelectorAll('a[data-store]');

    Array.prototype.forEach.call(links, function (link) {
      var token = decorate(link, attribution);
      if (!token) return;
      link.addEventListener('click', function () {
        track(link, token, attribution);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
