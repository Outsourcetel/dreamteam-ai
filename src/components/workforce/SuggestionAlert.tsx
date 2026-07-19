import React, { useState, useEffect } from 'react';
import { Lightbulb, TrendingDown, AlertCircle } from 'lucide-react';

export function SuggestionAlert() {
  const [suggestion, setSuggestion] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);

  // In a real implementation, this would poll for amendment suggestions
  // For now, we'll show a placeholder
  useEffect(() => {
    // Example suggestion
    setSuggestion({
      de_name: 'Support DE',
      metric_type: 'csat',
      current_csat: 78,
      suggestion: 'CSAT is 78% (goal 90%). Suggested: reduce guardrail strictness on approval actions.',
      confidence_score: 0.82,
      recommendation: 'HIGH',
    });
  }, []);

  if (!suggestion) {
    return null;
  }

  const getRecommendationColor = (rec: string) => {
    switch (rec) {
      case 'HIGH':
        return 'bg-red-900 border-red-700 text-red-100';
      case 'MEDIUM':
        return 'bg-amber-900 border-amber-700 text-amber-100';
      default:
        return 'bg-blue-900 border-blue-700 text-blue-100';
    }
  };

  return (
    <div className={`border rounded-lg p-3 ${getRecommendationColor(suggestion.recommendation)}`}>
      <div className="flex items-start gap-2">
        {suggestion.recommendation === 'HIGH' ? (
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        ) : (
          <Lightbulb className="w-4 h-4 flex-shrink-0 mt-0.5" />
        )}
        <div className="flex-1">
          <h4 className="font-bold text-sm">{suggestion.de_name}</h4>
          <p className="text-xs mt-1">{suggestion.suggestion}</p>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs opacity-75">Confidence: {Math.round(suggestion.confidence_score * 100)}%</span>
            <button className="text-xs bg-white/20 hover:bg-white/30 px-2 py-1 rounded transition">
              Review Proposal
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
