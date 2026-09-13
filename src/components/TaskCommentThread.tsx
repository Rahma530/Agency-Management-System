import React, { useState } from 'react';
import { Edit2, Trash2, Send } from 'lucide-react';
import { TaskCommentRecord, UserRecord } from '../types/database';

interface CommentActions {
  onAddComment: (taskId: string, body: string, parentCommentId?: string | null) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
}

interface CommentNodeProps extends CommentActions {
  comment: TaskCommentRecord;
  allComments: TaskCommentRecord[];
  users: UserRecord[];
  currentUserId: string;
  taskId: string;
  // 1 = top-level comment, 2 = reply, 3 = reply-to-reply — the deepest
  // allowed level (a DB trigger rejects a 4th), so "Reply" is hidden once
  // level reaches 3.
  level: 1 | 2 | 3;
}

const CommentNode: React.FC<CommentNodeProps> = ({
  comment,
  allComments,
  users,
  currentUserId,
  taskId,
  level,
  onAddComment,
  onEditComment,
  onDeleteComment,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const [isReplying, setIsReplying] = useState(false);
  const [replyBody, setReplyBody] = useState('');

  const author = users.find((u) => u.id === comment.author_id);
  const isOwn = comment.author_id === currentUserId;
  const isDeleted = !!comment.deleted_at;
  const replies = allComments.filter((c) => c.parent_comment_id === comment.id);
  const canReply = level < 3 && !isDeleted;

  const submitEdit = () => {
    if (!editBody.trim()) return;
    onEditComment(comment.id, editBody.trim());
    setIsEditing(false);
  };

  const submitReply = () => {
    if (!replyBody.trim()) return;
    onAddComment(taskId, replyBody.trim(), comment.id);
    setReplyBody('');
    setIsReplying(false);
  };

  return (
    <div className="space-y-2" style={{ paddingLeft: (level - 1) * 20 }}>
      <div
        className="p-2.5 rounded-lg border group/comment"
        style={{ background: 'rgba(21, 19, 24, 0.65)', borderColor: 'var(--border-soft)' }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center font-bold text-[9px] shrink-0"
              style={{ background: 'var(--gradient-badge)', color: 'white' }}
            >
              {author?.name.charAt(0) || '?'}
            </div>
            <span className="text-xs font-bold text-white truncate">{author?.name || 'Unknown'}</span>
            <span className="text-[10px] text-stone-500 shrink-0">
              {comment.created_at.split('T')[0]}
            </span>
            {comment.edited_at && !isDeleted && (
              <span className="text-[10px] text-stone-500 italic shrink-0">(edited)</span>
            )}
          </div>

          {isOwn && !isDeleted && !isEditing && (
            <div className="opacity-0 group-hover/comment:opacity-100 transition-opacity flex items-center gap-1 shrink-0">
              <button
                onClick={() => {
                  setEditBody(comment.body);
                  setIsEditing(true);
                }}
                className="p-1 rounded bg-stone-900 text-stone-400 hover:text-white"
                title="Edit"
              >
                <Edit2 className="w-3 h-3" />
              </button>
              <button
                onClick={() => onDeleteComment(comment.id)}
                className="p-1 rounded bg-stone-900 text-stone-400 hover:text-red-400"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {isDeleted ? (
          <p className="text-xs text-stone-500 italic mt-1.5">[comment deleted]</p>
        ) : isEditing ? (
          <div className="mt-1.5 space-y-1.5">
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              rows={2}
              className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white focus:outline-none focus:border-purple-500 resize-none"
            />
            <div className="flex items-center justify-end gap-1.5">
              <button
                onClick={() => setIsEditing(false)}
                className="px-2.5 py-1 rounded-lg text-[11px] text-stone-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={submitEdit}
                className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-purple-600 hover:bg-purple-500 text-white"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-stone-200 mt-1.5 whitespace-pre-wrap">{comment.body}</p>
        )}

        {canReply && !isReplying && (
          <button
            onClick={() => setIsReplying(true)}
            className="text-[10px] font-bold text-purple-300 hover:text-purple-200 mt-1.5"
          >
            Reply
          </button>
        )}

        {isReplying && (
          <div className="mt-1.5 space-y-1.5">
            <textarea
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              rows={2}
              placeholder="Write a reply..."
              className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-purple-500 resize-none"
            />
            <div className="flex items-center justify-end gap-1.5">
              <button
                onClick={() => setIsReplying(false)}
                className="px-2.5 py-1 rounded-lg text-[11px] text-stone-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={submitReply}
                className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-purple-600 hover:bg-purple-500 text-white"
              >
                Reply
              </button>
            </div>
          </div>
        )}
      </div>

      {replies.map((reply) => (
        <CommentNode
          key={reply.id}
          comment={reply}
          allComments={allComments}
          users={users}
          currentUserId={currentUserId}
          taskId={taskId}
          level={(level + 1) as 1 | 2 | 3}
          onAddComment={onAddComment}
          onEditComment={onEditComment}
          onDeleteComment={onDeleteComment}
        />
      ))}
    </div>
  );
};

interface TaskCommentThreadProps extends CommentActions {
  taskId: string;
  comments: TaskCommentRecord[];
  users: UserRecord[];
  currentUserId: string;
}

export const TaskCommentThread: React.FC<TaskCommentThreadProps> = ({
  taskId,
  comments,
  users,
  currentUserId,
  onAddComment,
  onEditComment,
  onDeleteComment,
}) => {
  const [newBody, setNewBody] = useState('');

  const taskComments = comments.filter((c) => c.task_id === taskId);
  const topLevel = taskComments.filter((c) => !c.parent_comment_id);

  const handlePost = () => {
    if (!newBody.trim()) return;
    onAddComment(taskId, newBody.trim(), null);
    setNewBody('');
  };

  return (
    <div className="space-y-3">
      {topLevel.length === 0 ? (
        <p className="text-xs text-stone-500 italic">No comments yet.</p>
      ) : (
        <div className="space-y-3 max-h-72 overflow-y-auto pr-0.5">
          {topLevel.map((comment) => (
            <CommentNode
              key={comment.id}
              comment={comment}
              allComments={taskComments}
              users={users}
              currentUserId={currentUserId}
              taskId={taskId}
              level={1}
              onAddComment={onAddComment}
              onEditComment={onEditComment}
              onDeleteComment={onDeleteComment}
            />
          ))}
        </div>
      )}

      <div className="flex items-start gap-2 pt-2 border-t border-stone-800">
        <textarea
          value={newBody}
          onChange={(e) => setNewBody(e.target.value)}
          rows={2}
          placeholder="Add a comment..."
          className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-stone-900 border border-stone-800 text-white placeholder-stone-500 focus:outline-none focus:border-purple-500 resize-none"
        />
        <button
          onClick={handlePost}
          className="p-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white shrink-0"
          title="Post comment"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
