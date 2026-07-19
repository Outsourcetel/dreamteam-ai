import React from 'react';

interface WorkforceConversationProps {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export function WorkforceConversation({
  role,
  content,
  timestamp,
}: WorkforceConversationProps) {
  const isUser = role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-xs px-4 py-2 rounded-lg ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-slate-700 text-slate-100'
        }`}
      >
        <p className="text-sm whitespace-pre-wrap">{content}</p>
        {timestamp && (
          <p className={`text-xs mt-1 ${isUser ? 'text-blue-200' : 'text-slate-400'}`}>
            {new Date(timestamp).toLocaleTimeString()}
          </p>
        )}
      </div>
    </div>
  );
}
