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
	update(sub: LinkedList): boolean;
	notify(sub: LinkedList): void;
	unwatched(sub: LinkedList): void;
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

	function link(dep: LinkedList, sub: LinkedList): void {
		const prevDep = sub.depTailNode;
		if (prevDep !== undefined && prevDep.depList === dep) {
			return;
		}
		let nextDep: LinkedListNode | undefined = undefined;
		const recursedCheck = sub.flags & 4 satisfies ReactiveFlags.RecursedCheck;
		if (recursedCheck) {
			nextDep = prevDep !== undefined ? prevDep.nextDepNode : sub.depHeadNode;
			if (nextDep !== undefined && nextDep.depList === dep) {
				sub.depTailNode = nextDep;
				return;
			}
		}
		const prevSub = dep.subTailNode;
		if (
			prevSub !== undefined
			&& prevSub.subList === sub
			&& (!recursedCheck || isValidLink(prevSub, sub))
		) {
			return;
		}
		const newLink
			= sub.depTailNode
			= dep.subTailNode
			= {
				depList: dep,
				subList: sub,
				prevDepNode: prevDep,
				nextDepNode: nextDep,
				prevSubNode: prevSub,
				nextSubNode: undefined,
			};
		if (nextDep !== undefined) {
			nextDep.prevDepNode = newLink;
		}
		if (prevDep !== undefined) {
			prevDep.nextDepNode = newLink;
		} else {
			sub.depHeadNode = newLink;
		}
		if (prevSub !== undefined) {
			prevSub.nextSubNode = newLink;
		} else {
			dep.subHeadNode = newLink;
		}
	}

	function unlink(link: LinkedListNode, sub = link.subList): LinkedListNode | undefined {
		const dep = link.depList;
		const prevDep = link.prevDepNode;
		const nextDep = link.nextDepNode;
		const nextSub = link.nextSubNode;
		const prevSub = link.prevSubNode;
		if (nextDep !== undefined) {
			nextDep.prevDepNode = prevDep;
		} else {
			sub.depTailNode = prevDep;
		}
		if (prevDep !== undefined) {
			prevDep.nextDepNode = nextDep;
		} else {
			sub.depHeadNode = nextDep;
		}
		if (nextSub !== undefined) {
			nextSub.prevSubNode = prevSub;
		} else {
			dep.subTailNode = prevSub;
		}
		if (prevSub !== undefined) {
			prevSub.nextSubNode = nextSub;
		} else if ((dep.subHeadNode = nextSub) === undefined) {
			unwatched(dep);
		}
		return nextDep;
	}

	function propagate(link: LinkedListNode): void {
		let next = link.nextSubNode;
		let stack: Stack<LinkedListNode | undefined> | undefined;

		top: do {
			const sub = link.subList;

			let flags = sub.flags;

			if (flags & 3 as ReactiveFlags.Mutable | ReactiveFlags.Watching) {
				if (!(flags & 60 as ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending)) {
					sub.flags = flags | 32 satisfies ReactiveFlags.Pending;
				} else if (!(flags & 12 as ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed)) {
					flags = 0 satisfies ReactiveFlags.None;
				} else if (!(flags & 4 satisfies ReactiveFlags.RecursedCheck)) {
					sub.flags = (flags & ~(8 satisfies ReactiveFlags.Recursed)) | 32 satisfies ReactiveFlags.Pending;
				} else if (!(flags & 48 as ReactiveFlags.Dirty | ReactiveFlags.Pending) && isValidLink(link, sub)) {
					sub.flags = flags | 40 as ReactiveFlags.Recursed | ReactiveFlags.Pending;
					flags &= 1 satisfies ReactiveFlags.Mutable;
				} else {
					flags = 0 satisfies ReactiveFlags.None;
				}

				if (flags & 2 satisfies ReactiveFlags.Watching) {
					notify(sub);
				}

				if (flags & 1 satisfies ReactiveFlags.Mutable) {
					const subSubs = sub.subHeadNode;
					if (subSubs !== undefined) {
						link = subSubs;
						if (subSubs.nextSubNode !== undefined) {
							stack = { value: next, prev: stack };
							next = link.nextSubNode;
						}
						continue;
					}
				}
			}

			if ((link = next!) !== undefined) {
				next = link.nextSubNode;
				continue;
			}

			while (stack !== undefined) {
				link = stack.value!;
				stack = stack.prev;
				if (link !== undefined) {
					next = link.nextSubNode;
					continue top;
				}
			}

			break;
		} while (true);
	}

	function startTracking(sub: LinkedList): void {
		sub.depTailNode = undefined;
		sub.flags = (sub.flags & ~(56 as ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending)) | 4 satisfies ReactiveFlags.RecursedCheck;
	}

	function endTracking(sub: LinkedList): void {
		const depsTail = sub.depTailNode;
		let toRemove = depsTail !== undefined ? depsTail.nextDepNode : sub.depHeadNode;
		while (toRemove !== undefined) {
			toRemove = unlink(toRemove, sub);
		}
		sub.flags &= ~(4 satisfies ReactiveFlags.RecursedCheck);
	}

	function checkDirty(link: LinkedListNode, sub: LinkedList): boolean {
		let stack: Stack<LinkedListNode> | undefined;
		let checkDepth = 0;

		top: do {
			const dep = link.depList;
			const depFlags = dep.flags;

			let dirty = false;

			if (sub.flags & 16 satisfies ReactiveFlags.Dirty) {
				dirty = true;
			} else if ((depFlags & 17 as ReactiveFlags.Mutable | ReactiveFlags.Dirty) === 17 as ReactiveFlags.Mutable | ReactiveFlags.Dirty) {
				if (update(dep)) {
					const subs = dep.subHeadNode!;
					if (subs.nextSubNode !== undefined) {
						shallowPropagate(subs);
					}
					dirty = true;
				}
			} else if ((depFlags & 33 as ReactiveFlags.Mutable | ReactiveFlags.Pending) === 33 as ReactiveFlags.Mutable | ReactiveFlags.Pending) {
				if (link.nextSubNode !== undefined || link.prevSubNode !== undefined) {
					stack = { value: link, prev: stack };
				}
				link = dep.depHeadNode!;
				sub = dep;
				++checkDepth;
				continue;
			}

			if (!dirty && link.nextDepNode !== undefined) {
				link = link.nextDepNode;
				continue;
			}

			while (checkDepth) {
				--checkDepth;
				const firstSub = sub.subHeadNode!;
				const hasMultipleSubs = firstSub.nextSubNode !== undefined;
				if (hasMultipleSubs) {
					link = stack!.value;
					stack = stack!.prev;
				} else {
					link = firstSub;
				}
				if (dirty) {
					if (update(sub)) {
						if (hasMultipleSubs) {
							shallowPropagate(firstSub);
						}
						sub = link.subList;
						continue;
					}
				} else {
					sub.flags &= ~(32 satisfies ReactiveFlags.Pending);
				}
				sub = link.subList;
				if (link.nextDepNode !== undefined) {
					link = link.nextDepNode;
					continue top;
				}
				dirty = false;
			}

			return dirty;
		} while (true);
	}

	function shallowPropagate(link: LinkedListNode): void {
		do {
			const sub = link.subList;
			const nextSub = link.nextSubNode;
			const subFlags = sub.flags;
			if ((subFlags & 48 as ReactiveFlags.Pending | ReactiveFlags.Dirty) === 32 satisfies ReactiveFlags.Pending) {
				sub.flags = subFlags | 16 satisfies ReactiveFlags.Dirty;
				if (subFlags & 2 satisfies ReactiveFlags.Watching) {
					notify(sub);
				}
			}
			link = nextSub!;
		} while (link !== undefined);
	}

	function isValidLink(checkLink: LinkedListNode, sub: LinkedList): boolean {
		const depsTail = sub.depTailNode;
		if (depsTail !== undefined) {
			let link = sub.depHeadNode!;
			do {
				if (link === checkLink) {
					return true;
				}
				if (link === depsTail) {
					break;
				}
				link = link.nextDepNode!;
			} while (link !== undefined);
		}
		return false;
	}
}
