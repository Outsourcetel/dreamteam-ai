import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { PerformanceDashboard } from '../../components/workforce/PerformanceDashboard';
import { DETrainingPanel } from '../../components/workforce/DETrainingPanel';
import { SuggestionAlert } from '../../components/workforce/SuggestionAlert';
import { DraftApprovalCard } from '../../components/workforce/DraftApprovalCard';
import { WorkforceConversation } from '../../components/workforce/WorkforceConversation';
import {
  sendWorkforceMessage,
  listUserConversations,
  getPendingActions,
  getPerformanceSummary,
  WorkforceConversation as IWorkforceConversation,
  WorkforceAction,
  DEPerformanceSummary,
} from '../../lib/workforceApi';
import { useAuth } from '../../context/AuthContext';
import { Loader } from '../../components/workforce/icons';

export function WorkforceChatHubPage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const { authedUser: user } = useAuth();

  // Chat state
  const [conversations, setConversations] = useState<IWorkforceConversation[]>([]);
  const [currentConversation, setCurrentConversation] = useState<IWorkforceConversation | null>(null);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Actions state
  const [pendingActions, setPendingActions] = useState<WorkforceAction[]>([]);
  const [selectedDEId, setSelectedDEId] = useState<string | null>(null);
  const [dePerformance, setDEPerformance] = useState<DEPerformanceSummary | null>(null);

  const messageEndRef = useRef<HTMLDivElement>(null);

  // Load conversations on mount
  useEffect(() => {
    if (tenantId) {
      loadConversations();
      loadPendingActions();
    }
  }, [tenantId]);

  // Load DE performance when selected
  useEffect(() => {
    if (selectedDEId) {
      loadDEPerformance(selectedDEId);
    }
  }, [selectedDEId]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentConversation?.messages]);

  const loadConversations = async () => {
    if (!tenantId) return;
    try {
      const convos = await listUserConversations(tenantId);
      setConversations(convos);
      if (convos.length > 0 && !currentConversation) {
        setCurrentConversation(convos[0]);
      }
    } catch (err) {
      setError('Failed to load conversations');
      console.error(err);
    }
  };

  const loadPendingActions = async () => {
    if (!tenantId) return;
    try {
      const actions = await getPendingActions(tenantId);
      setPendingActions(actions);
    } catch (err) {
      console.error('Failed to load pending actions:', err);
    }
  };

  const loadDEPerformance = async (deId: string) => {
    try {
      const perf = await getPerformanceSummary(deId);
      setDEPerformance(perf);
    } catch (err) {
      console.error('Failed to load DE performance:', err);
    }
  };

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || !tenantId) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await sendWorkforceMessage(
        tenantId,
        inputMessage,
        currentConversation?.conversation_id
      );

      if (!currentConversation) {
        // Create new conversation from response
        const newConversation: IWorkforceConversation = {
          conversation_id: response.conversation_id,
          tenant_id: tenantId,
          user_id: user?.id || '',
          de_id: '', // Will be fetched
          topic: response.topic as any,
          status: 'active',
          messages: [
            { role: 'user', content: inputMessage, timestamp: new Date().toISOString() },
            { role: 'assistant', content: response.message, timestamp: new Date().toISOString() },
          ],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setCurrentConversation(newConversation);
        setConversations([newConversation, ...conversations]);
      } else {
        // Update existing conversation
        const updatedConversation: IWorkforceConversation = {
          ...currentConversation,
          messages: [
            ...currentConversation.messages,
            { role: 'user', content: inputMessage, timestamp: new Date().toISOString() },
            { role: 'assistant', content: response.message, timestamp: new Date().toISOString() },
          ],
          updated_at: new Date().toISOString(),
        };
        setCurrentConversation(updatedConversation);
        setConversations(
          conversations.map((c) =>
            c.conversation_id === currentConversation.conversation_id ? updatedConversation : c
          )
        );
      }

      setInputMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-dt-page">
      {/* Header */}
      <div className="border-b border-dt-border bg-dt-page px-6 py-4">
        <h1 className="text-2xl font-bold text-dt-title">Workforce Assistant</h1>
        <p className="text-dt-support text-sm mt-1">
          Manage your digital workforce conversationally — hire, improve, monitor, retire.
          <span className="text-dt-muted"> For editing knowledge, playbooks or settings in plain language, use the ✨ Workspace Assistant (bottom-right on any page).</span>
        </p>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar: Conversation list */}
        <div className="w-64 border-r border-dt-border bg-dt-page flex flex-col overflow-hidden">
          {/* New conversation button */}
          <button
            onClick={() => {
              setCurrentConversation(null);
              setInputMessage('');
            }}
            className="m-3 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition"
          >
            + New Conversation
          </button>

          {/* Conversation list */}
          <div className="flex-1 overflow-y-auto">
            {conversations.map((conv) => (
              <button
                key={conv.conversation_id}
                onClick={() => setCurrentConversation(conv)}
                className={`w-full text-left px-4 py-3 border-b border-dt-border transition ${
                  currentConversation?.conversation_id === conv.conversation_id
                    ? 'bg-dt-card border-l-2 border-l-blue-500'
                    : 'hover:bg-dt-panel'
                }`}
              >
                <div className="font-medium text-dt-body text-sm">
                  {conv.topic.charAt(0).toUpperCase() + conv.topic.slice(1)}
                </div>
                <div className="text-xs text-dt-muted mt-1 truncate">
                  {conv.messages[0]?.content || 'No messages'}
                </div>
              </button>
            ))}
          </div>

          {/* Pending actions count */}
          {pendingActions.length > 0 && (
            <div className="p-3 border-t border-dt-border bg-dt-card">
              <div className="text-xs font-medium text-amber-400 flex items-center">
                ⚠️ {pendingActions.length} Pending Approval
              </div>
            </div>
          )}
        </div>

        {/* Main content area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Chat area and dashboard side-by-side */}
          <div className="flex flex-1 overflow-hidden gap-4 p-4">
            {/* Chat messages */}
            <div className="flex-1 flex flex-col bg-dt-card rounded-lg overflow-hidden">
              {currentConversation ? (
                <>
                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {currentConversation.messages.map((msg, idx) => (
                      <WorkforceConversation
                        key={idx}
                        role={msg.role}
                        content={msg.content}
                        timestamp={msg.timestamp}
                      />
                    ))}
                    {isLoading && (
                      <div className="flex items-center justify-center py-4">
                        <Loader className="w-5 h-5 animate-spin text-blue-400" />
                      </div>
                    )}
                    <div ref={messageEndRef} />
                  </div>

                  {/* Error display */}
                  {error && (
                    <div className="px-4 py-2 bg-red-900 text-red-100 text-sm">
                      {error}
                    </div>
                  )}

                  {/* Input area */}
                  <div className="border-t border-dt-border p-4">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={inputMessage}
                        onChange={(e) => setInputMessage(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSendMessage();
                          }
                        }}
                        placeholder="Describe what you need... (e.g., 'I want to hire someone for escalations')"
                        className="flex-1 bg-dt-panel border border-dt-border-strong rounded px-3 py-2 text-dt-title placeholder-slate-500"
                      />
                      <button
                        onClick={handleSendMessage}
                        disabled={isLoading || !inputMessage.trim()}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-dt-panel text-white rounded transition"
                      >
                        Send
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-dt-support">
                  <div className="text-center">
                    <p className="text-lg">Start a new conversation</p>
                    <p className="text-sm mt-2">Tell the Workforce Assistant what you need</p>
                  </div>
                </div>
              )}
            </div>

            {/* Right sidebar: Performance + Suggestions + Pending Approvals */}
            <div className="w-96 flex flex-col gap-4 overflow-y-auto">
              {/* Suggestion alerts */}
              <SuggestionAlert />

              {/* Pending actions */}
              {pendingActions.length > 0 && (
                <div className="bg-dt-card rounded-lg p-4">
                  <h3 className="font-bold text-dt-title mb-3">Pending Approval ({pendingActions.length})</h3>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {pendingActions.map((action) => (
                      <DraftApprovalCard key={action.action_id} action={action} />
                    ))}
                  </div>
                </div>
              )}

              {/* Performance dashboard */}
              {selectedDEId && dePerformance && (
                <PerformanceDashboard performance={dePerformance} />
              )}

              {/* Training panel if in shadow/co-pilot stage */}
              {selectedDEId && <DETrainingPanel deId={selectedDEId} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
