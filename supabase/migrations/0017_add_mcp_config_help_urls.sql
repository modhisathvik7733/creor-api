-- Add helpUrl to configParams for existing catalog entries
-- This updates the JSONB config_params to include help URLs for each parameter

UPDATE "mcp_catalog" SET "config_params" = '[{"key":"GITHUB_PERSONAL_ACCESS_TOKEN","label":"GitHub Personal Access Token","placeholder":"ghp_xxxxxxxxxxxxxxxxxxxx","required":true,"secret":true,"helpUrl":"https://github.com/settings/tokens?type=beta"}]' WHERE "slug" = 'github';

UPDATE "mcp_catalog" SET "config_params" = '[{"key":"SLACK_BOT_TOKEN","label":"Slack Bot Token","placeholder":"xoxb-...","required":true,"secret":true,"helpUrl":"https://api.slack.com/apps"},{"key":"SLACK_TEAM_ID","label":"Slack Team ID","placeholder":"T0123456789","required":true,"secret":false,"helpUrl":"https://slack.com/help/articles/221769328-Locate-your-Slack-URL-or-ID"}]' WHERE "slug" = 'slack';

UPDATE "mcp_catalog" SET "config_params" = '[{"key":"NOTION_API_KEY","label":"Notion Integration Token","placeholder":"ntn_...","required":true,"secret":true,"helpUrl":"https://www.notion.so/profile/integrations"}]' WHERE "slug" = 'notion';

UPDATE "mcp_catalog" SET "config_params" = '[{"key":"LINEAR_API_KEY","label":"Linear API Key","placeholder":"lin_api_...","required":true,"secret":true,"helpUrl":"https://linear.app/settings/api"}]' WHERE "slug" = 'linear';

UPDATE "mcp_catalog" SET "config_params" = '[{"key":"BRAVE_API_KEY","label":"Brave Search API Key","placeholder":"BSA...","required":true,"secret":true,"helpUrl":"https://brave.com/search/api/"}]' WHERE "slug" = 'brave-search';

UPDATE "mcp_catalog" SET "config_params" = '[{"key":"GDRIVE_CLIENT_ID","label":"Google OAuth Client ID","placeholder":"xxxx.apps.googleusercontent.com","required":true,"secret":false,"helpUrl":"https://console.cloud.google.com/apis/credentials"},{"key":"GDRIVE_CLIENT_SECRET","label":"Google OAuth Client Secret","placeholder":"GOCSPX-...","required":true,"secret":true,"helpUrl":"https://console.cloud.google.com/apis/credentials"}]' WHERE "slug" = 'google-drive';

UPDATE "mcp_catalog" SET "config_params" = '[{"key":"SENTRY_AUTH_TOKEN","label":"Sentry Auth Token","placeholder":"sntrys_...","required":true,"secret":true,"helpUrl":"https://sentry.io/settings/auth-tokens/"}]' WHERE "slug" = 'sentry';

UPDATE "mcp_catalog" SET "config_params" = '[{"key":"EXA_API_KEY","label":"Exa API Key","placeholder":"exa-...","required":true,"secret":true,"helpUrl":"https://dashboard.exa.ai/api-keys"}]' WHERE "slug" = 'exa';

UPDATE "mcp_catalog" SET "config_params" = '[{"key":"TODOIST_API_TOKEN","label":"Todoist API Token","placeholder":"your-api-token","required":true,"secret":true,"helpUrl":"https://app.todoist.com/app/settings/integrations/developer"}]' WHERE "slug" = 'todoist';
