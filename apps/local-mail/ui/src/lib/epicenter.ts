/**
 * The one thing this application reaches its files and its secrets through.
 *
 * Semantic Gmail calls stay app-owned; what is here is the handle they file
 * and store credentials with.
 *
 * One `createEpicenter`, composed here rather than in two platform leaves that
 * differed on an import line. No `definition` and no `account`: Local Mail
 * holds no Epicenter Data, so its handle has no `data` and no `account` to
 * read, and the seam holds the only thing that varies, which is who owns the
 * files and the keychain (ADR-0339).
 */

import { createEpicenter } from '@epicenter/app';
import { LOCAL_MAIL_APP_ID } from '@epicenter/local-mail/storage';
import { binding } from '#platform/binding';

export const epicenter = createEpicenter({ appId: LOCAL_MAIL_APP_ID, binding });
