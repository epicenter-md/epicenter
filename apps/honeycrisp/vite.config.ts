import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';

export default workspaceAppViteConfig(APPS.HONEYCRISP, { tauri: true });
