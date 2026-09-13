import { PlatformCategory } from '../types/database';

// Module 6 (External Integrations Hub) scaffolding — static catalog of the
// platforms staff can track connection status for. Not tied 1:1 to the
// exact platform strings used in campaigns.platform / social_insights.platform
// (those are free-text values entered per row today); this is a fixed list
// distinct across categories so (client_id, platform_name) stays unique.
export interface IntegrationPlatformDef {
  key: string;
  label: string;
  category: PlatformCategory;
}

export const INTEGRATION_CATEGORY_LABELS: Record<PlatformCategory, string> = {
  media_buying: 'Media Buying',
  analytics: 'Analytics & Traffic',
  social_media: 'Social Media Engagement',
};

export const INTEGRATION_PLATFORMS: IntegrationPlatformDef[] = [
  { key: 'meta_ads', label: 'Meta Ads', category: 'media_buying' },
  { key: 'google_ads', label: 'Google Ads', category: 'media_buying' },
  { key: 'tiktok_ads', label: 'TikTok Ads', category: 'media_buying' },
  { key: 'linkedin_ads', label: 'LinkedIn Ads', category: 'media_buying' },
  { key: 'snapchat_ads', label: 'Snapchat Ads', category: 'media_buying' },
  { key: 'x_ads', label: 'X Ads', category: 'media_buying' },

  { key: 'google_analytics', label: 'Google Analytics (GA4)', category: 'analytics' },
  { key: 'google_search_console', label: 'Google Search Console', category: 'analytics' },

  { key: 'facebook_page', label: 'Facebook Page', category: 'social_media' },
  { key: 'instagram_business', label: 'Instagram Business', category: 'social_media' },
  { key: 'tiktok_social', label: 'TikTok', category: 'social_media' },
  { key: 'x_social', label: 'X (Twitter)', category: 'social_media' },
  { key: 'linkedin_page', label: 'LinkedIn Page', category: 'social_media' },
];
