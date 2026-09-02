/**
 * There is no `~/Epicenter` folder in a browser tab.
 *
 * A page has no filesystem, so there is nothing for a checkout to land in and
 * no route that could take one. The build answers this, not a runtime probe:
 * a person in an ordinary browser never meets the button, rather than meeting
 * one that always fails.
 */
export const HAS_FOLDER = false;
