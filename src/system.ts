export interface LinkedList {
	depHeadNode?: LinkedListNode;
	depTailNode?: LinkedListNode;
	subHeadNode?: LinkedListNode;
	subTailNode?: LinkedListNode;
	flags: ReactiveFlags;
}

export interface LinkedListNode {
	depList: LinkedList;
	subList: LinkedList;
	prevSubNode: LinkedListNode | undefined;
	nextSubNode: LinkedListNode | undefined;
	prevDepNode: LinkedListNode | undefined;
	nextDepNode: LinkedListNode | undefined;
}

interface Stack<T> {
	value: T;
	prev: Stack<T> | undefined;
}

export enum ReactiveFlags {
	None = 0,
	Mutable = 1 << 0,
	Watching = 1 << 1,
	RecursedCheck = 1 << 2,
	Recursed = 1 << 3,
	Dirty = 1 << 4,
	Pending = 1 << 5,
}

export function createReactiveSystem({
	update,
	notify,
	unwatched,
}: {
	update(subList: LinkedList): boolean;
	notify(subList: LinkedList): void;
	unwatched(subList: LinkedList): void;
}) {
	return {
		link,
		unlink,
		propagate,
		checkDirty,
		endTracking,
		startTracking,
		shallowPropagate,
	};

	function link(depList: LinkedList, subList: LinkedList): void {
		const depTailNode = subList.depTailNode;
		if (depTailNode !== undefined && depTailNode.depList === depList) {
			return;
		}
		let nextDepNode: LinkedListNode | undefined = undefined;
		const recursedCheck = subList.flags & 4 satisfies ReactiveFlags.RecursedCheck;
		if (recursedCheck) {
			nextDepNode = depTailNode !== undefined ? depTailNode.nextDepNode : subList.depHeadNode;
			if (nextDepNode !== undefined && nextDepNode.depList === depList) {
				subList.depTailNode = nextDepNode;
				return;
			}
		}
		const subTailNode = depList.subTailNode;
		if (
			subTailNode !== undefined
			&& subTailNode.subList === subList
			&& (!recursedCheck || isValidLink(subTailNode, subList))
		) {
			return;
		}
		const newNode
			= subList.depTailNode
			= depList.subTailNode
			= {
				depList,
				subList,
				prevDepNode: depTailNode,
				nextDepNode,
				prevSubNode: subTailNode,
				nextSubNode: undefined,
			};
		if (nextDepNode !== undefined) {
			nextDepNode.prevDepNode = newNode;
		}
		if (depTailNode !== undefined) {
			depTailNode.nextDepNode = newNode;
		} else {
			subList.depHeadNode = newNode;
		}
		if (subTailNode !== undefined) {
			subTailNode.nextSubNode = newNode;
		} else {
			depList.subHeadNode = newNode;
		}
	}

	function unlink(link: LinkedListNode, sub = link.subList): LinkedListNode | undefined {
		const depList = link.depList;
		const prevDepNode = link.prevDepNode;
		const nextDepNode = link.nextDepNode;
		const nextSubNode = link.nextSubNode;
		const prevSubNode = link.prevSubNode;
		if (nextDepNode !== undefined) {
			nextDepNode.prevDepNode = prevDepNode;
		} else {
			sub.depTailNode = prevDepNode;
		}
		if (prevDepNode !== undefined) {
			prevDepNode.nextDepNode = nextDepNode;
		} else {
			sub.depHeadNode = nextDepNode;
		}
		if (nextSubNode !== undefined) {
			nextSubNode.prevSubNode = prevSubNode;
		} else {
			depList.subTailNode = prevSubNode;
		}
		if (prevSubNode !== undefined) {
			prevSubNode.nextSubNode = nextSubNode;
		} else if ((depList.subHeadNode = nextSubNode) === undefined) {
			unwatched(depList);
		}
		return nextDepNode;
	}

	function propagate(node: LinkedListNode): void {
		let nextSubNode = node.nextSubNode;
		let stack: Stack<LinkedListNode | undefined> | undefined;

		top: do {
			const subList = node.subList;

			let flags = subList.flags;

			if (flags & 3 as ReactiveFlags.Mutable | ReactiveFlags.Watching) {
				if (!(flags & 60 as ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending)) {
					subList.flags = flags | 32 satisfies ReactiveFlags.Pending;
				} else if (!(flags & 12 as ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed)) {
					flags = 0 satisfies ReactiveFlags.None;
				} else if (!(flags & 4 satisfies ReactiveFlags.RecursedCheck)) {
					subList.flags = (flags & ~(8 satisfies ReactiveFlags.Recursed)) | 32 satisfies ReactiveFlags.Pending;
				} else if (!(flags & 48 as ReactiveFlags.Dirty | ReactiveFlags.Pending) && isValidLink(node, subList)) {
					subList.flags = flags | 40 as ReactiveFlags.Recursed | ReactiveFlags.Pending;
					flags &= 1 satisfies ReactiveFlags.Mutable;
				} else {
					flags = 0 satisfies ReactiveFlags.None;
				}

				if (flags & 2 satisfies ReactiveFlags.Watching) {
					notify(subList);
				}

				if (flags & 1 satisfies ReactiveFlags.Mutable) {
					const subsSubHeadNode = subList.subHeadNode;
					if (subsSubHeadNode !== undefined) {
						node = subsSubHeadNode;
						if (subsSubHeadNode.nextSubNode !== undefined) {
							stack = { value: nextSubNode, prev: stack };
							nextSubNode = node.nextSubNode;
						}
						continue;
					}
				}
			}

			if ((node = nextSubNode!) !== undefined) {
				nextSubNode = node.nextSubNode;
				continue;
			}

			while (stack !== undefined) {
				node = stack.value!;
				stack = stack.prev;
				if (node !== undefined) {
					nextSubNode = node.nextSubNode;
					continue top;
				}
			}

			break;
		} while (true);
	}

	function startTracking(subList: LinkedList): void {
		subList.depTailNode = undefined;
		subList.flags = (subList.flags & ~(56 as ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending)) | 4 satisfies ReactiveFlags.RecursedCheck;
	}

	function endTracking(subList: LinkedList): void {
		const depTailNode = subList.depTailNode;
		let toRemove = depTailNode !== undefined ? depTailNode.nextDepNode : subList.depHeadNode;
		while (toRemove !== undefined) {
			toRemove = unlink(toRemove, subList);
		}
		subList.flags &= ~(4 satisfies ReactiveFlags.RecursedCheck);
	}

	function checkDirty(node: LinkedListNode, subList: LinkedList): boolean {
		let stack: Stack<LinkedListNode> | undefined;
		let checkDepth = 0;

		top: do {
			const depList = node.depList;
			const depFlags = depList.flags;

			let dirty = false;

			if (subList.flags & 16 satisfies ReactiveFlags.Dirty) {
				dirty = true;
			} else if ((depFlags & 17 as ReactiveFlags.Mutable | ReactiveFlags.Dirty) === 17 as ReactiveFlags.Mutable | ReactiveFlags.Dirty) {
				if (update(depList)) {
					const subs = depList.subHeadNode!;
					if (subs.nextSubNode !== undefined) {
						shallowPropagate(subs);
					}
					dirty = true;
				}
			} else if ((depFlags & 33 as ReactiveFlags.Mutable | ReactiveFlags.Pending) === 33 as ReactiveFlags.Mutable | ReactiveFlags.Pending) {
				if (node.nextSubNode !== undefined || node.prevSubNode !== undefined) {
					stack = { value: node, prev: stack };
				}
				node = depList.depHeadNode!;
				subList = depList;
				++checkDepth;
				continue;
			}

			if (!dirty && node.nextDepNode !== undefined) {
				node = node.nextDepNode;
				continue;
			}

			while (checkDepth) {
				--checkDepth;
				const firstSub = subList.subHeadNode!;
				const hasMultipleSubs = firstSub.nextSubNode !== undefined;
				if (hasMultipleSubs) {
					node = stack!.value;
					stack = stack!.prev;
				} else {
					node = firstSub;
				}
				if (dirty) {
					if (update(subList)) {
						if (hasMultipleSubs) {
							shallowPropagate(firstSub);
						}
						subList = node.subList;
						continue;
					}
				} else {
					subList.flags &= ~(32 satisfies ReactiveFlags.Pending);
				}
				subList = node.subList;
				if (node.nextDepNode !== undefined) {
					node = node.nextDepNode;
					continue top;
				}
				dirty = false;
			}

			return dirty;
		} while (true);
	}

	function shallowPropagate(node: LinkedListNode): void {
		do {
			const subList = node.subList;
			const nextSubNode = node.nextSubNode;
			const subListFlags = subList.flags;
			if ((subListFlags & 48 as ReactiveFlags.Pending | ReactiveFlags.Dirty) === 32 satisfies ReactiveFlags.Pending) {
				subList.flags = subListFlags | 16 satisfies ReactiveFlags.Dirty;
				if (subListFlags & 2 satisfies ReactiveFlags.Watching) {
					notify(subList);
				}
			}
			node = nextSubNode!;
		} while (node !== undefined);
	}

	function isValidLink(checkNode: LinkedListNode, subList: LinkedList): boolean {
		const depTailNode = subList.depTailNode;
		if (depTailNode !== undefined) {
			let depHeadNode = subList.depHeadNode!;
			do {
				if (depHeadNode === checkNode) {
					return true;
				}
				if (depHeadNode === depTailNode) {
					break;
				}
				depHeadNode = depHeadNode.nextDepNode!;
			} while (depHeadNode !== undefined);
		}
		return false;
	}
}
