# Picking the Right Abstraction with Workspace and WorkspaceConfig: A Lesson in Naming

I originally named, so basically in this application I had the decision of an abstraction between workspace and workspace config. I originally named everything a workspace. I saved them locally to the storage, but there was one problem. These workspaces could be enhanced or I could merge them with additional properties for myself to be able, like whether or not it's connected and information about the workspace and so forth, but that has to be done on the open code server. So the way I approached this is that, okay, the old workspace became workspace config and then the new merged type would be called workspace. I think this is a great demonstration of picking the right abstractions. In coding, there's a lot of decisions you have to make where the names and the nouns you use should very properly describe what you're trying to do here and like what exactly each of them are here. Like I could have called it a workspace and maybe something else, but I thought a lot about it and I realized I want to save the workspace configurations. These are a fraction of the total workspace, right? So, but the things I'm saving for the user are just the configuration things like the connection strings and so forth. This is a perfect noun for that. And then the workspace itself can represent also the connected status and everything else. I think these sort of abstractions are really helpful. At the end of the day, a lot of abstractions are loaded nouns like this. Anyway, so this exact voice transcript, basically a lot of that voice, I want you to turn it into basically a very effective blog article.

I just spent the morning renaming everything in my codebase from "workspace" to "workspaceConfig". All of it. Every import, every function, every component. Why? Because I picked the wrong abstraction the first time around.

Here's what happened.

## The Problem

I was building OpenCode's web UI and needed to store connection details locally. URL, port, username, password. The basics you need to connect to a server. I called these "workspaces" and saved them to localStorage. Simple enough.

```typescript
const workspace = {
  id: 'abc123',
  name: 'My Project',
  url: 'https://xyz.ngrok.io',
  port: 55001,
  username: 'admin',
  password: 'secret'
};
```

But then I needed to show whether each workspace was actually connected. And when it was connected, I wanted to display information from the server. The current working directory, git status, available models. This information couldn't be stored locally; it had to come from the server.

So now I had two different things:
1. The configuration I saved locally (connection details)
2. The enhanced workspace with live server data

But they were both called "workspace".

## The Confusion

This created a mess. Sometimes `workspace` meant just the config. Sometimes it meant the config plus the server data. Functions like `getWorkspace()` were ambiguous. Were they getting the saved config or the live data?

```typescript
// Which workspace are we talking about?
function displayWorkspace(workspace: ???) {
  // Is workspace.connected available here?
  // What about workspace.appInfo?
}
```

I kept having to check types, add comments, and explain to myself which "workspace" I was dealing with.

## The Realization

Then it hit me. I wasn't storing workspaces locally. I was storing workspace *configurations*.

The configuration is just a fraction of what a workspace actually is. It's the connection recipe, not the connection itself. It's like the difference between a phone number and an actual phone conversation.

Once I saw it this way, the naming became obvious:
- `WorkspaceConfig`: What I save locally (the connection details)
- `Workspace`: The config enhanced with live server data

```typescript
// Crystal clear
type WorkspaceConfig = {
  id: string;
  name: string;
  url: string;
  port: number;
  username: string;
  password: string;
};

type Workspace = WorkspaceConfig & {
  connected: boolean;
  checkedAt: number;
  appInfo?: ServerAppInfo;
};
```

Now every function name tells you exactly what it's dealing with:
- `createWorkspaceConfig()` - saves connection details
- `getWorkspace()` - fetches config + live server data
- `updateWorkspaceConfig()` - updates saved settings

No ambiguity. No confusion. The types enforce the distinction.

## The Lesson

Naming isn't just about picking words that sound good. It's about capturing the precise relationship between concepts in your system.

I could have gone with other names:
- `WorkspaceSettings` and `Workspace`
- `SavedWorkspace` and `LiveWorkspace`
- `WorkspaceConnection` and `Workspace`

But "config" was the right abstraction because that's exactly what I was storing. Configuration data. Not the workspace itself, just the instructions for how to connect to one.

This kind of precision matters. Bad abstractions create confusion that compounds over time. You write unclear functions. You add unnecessary comments. You second-guess yourself constantly.

Good abstractions do the opposite. They make the code explain itself. They guide you toward correct implementations. They make future changes obvious.

The two hours I spent renaming everything? Worth it. The codebase is clearer. The types are more precise. And I'm not fighting my own naming decisions anymore.

Sometimes the best refactoring is just finding the right words.