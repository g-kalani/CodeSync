import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';

export const initCollaboration = (editor, roomId) => {
    const ydoc = new Y.Doc();

    const serverUrl = process.env.NODE_ENV === 'production' 
        ? 'wss://code-editor-app-euzi.onrender.com' 
        : 'ws://localhost:10000';

    const provider = new WebsocketProvider(
        serverUrl, 
        roomId, 
        ydoc
    );

    const ytext = ydoc.getText('monaco');

    const binding = new MonacoBinding(
        ytext,
        editor.getModel(),
        new Set([editor]),
        provider.awareness
    );

    return { ydoc, provider, binding };
};