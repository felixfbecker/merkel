
export function prepareCommitMessage(commitMessage: string): string {
    return commitMessage;
}

export function isRevertCommit(commitMessage: string): boolean {
    return /Revert/.test(commitMessage);
}

export function addMerkelCommands(commitMessage: string): string {
    return commitMessage + '[merkel down 5]';
}
