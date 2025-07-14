export interface ReactiveNode {
	/**
	 * Связанный список зависимостей - при их изменении этот узел должен перезапуститься.
	 * ```ts
	 * const data = signal(1);
	 * const timesTwo = computed(() => data() * 2);
	 * timesTwo();
	 * // timesTwo.deps -> data
	 * // data.subs -> timesTwo
	 * ```
	 */
	deps?: Link;
	depsTail?: Link;
	/** Связанный список подписчиков - при изменении этого узла уведомить их. */
	subs?: Link;
	subsTail?: Link;
	flags: ReactiveFlags;
}

export interface Link {
	dep: ReactiveNode;
	sub: ReactiveNode;
	prevSub: Link | undefined;
	nextSub: Link | undefined;
	prevDep: Link | undefined;
	nextDep: Link | undefined;
}

interface Stack<T> {
	value: T;
	prev: Stack<T> | undefined;
}

export const enum ReactiveFlags {
	None = 0,
	/**
	 * Когда ReactiveNode используется как зависимость, его значение является мутабельным,
	 * поэтому propagate должен установить Pending/Dirty для него, а checkDirty должен
	 * инициировать обновление для него.
	 */
	Mutable = 1 << 0,
	/** Наблюдаемый узел будет вызывать `notify(node)` при изменении его зависимостей. */
	Watching = 1 << 1,
	/**
	 * RecursedCheck, Recursed: Во время выполнения effect/computed, если другие
	 * значения сигналов изменяются, что косвенно или напрямую приводит к установке
	 * effect/computed в состояние Pending/Dirty во время выполнения, это нужно
	 * записать как Recursed для избежания сбоев. Цель - решить такие граничные случаи:
	 * https://github.com/proposal-signals/signal-polyfill/pull/44/files#diff-11c8a943a1bcaf1e91e4bbcd27a589556340630ae5bb31f57884c8ef584b9fa5
	 */
	RecursedCheck = 1 << 2,
	Recursed = 1 << 3,
	/* Грязный узел точно нуждается в перезапуске. */
	Dirty = 1 << 4,
	/** Ожидающий узел возможно нуждается в перезапуске. */
	Pending = 1 << 5,
}

/**
 * Создает реактивную систему, которая распространяет уведомления о загрязнении
 * от зависимостей к подписчикам.
 */
export function createReactiveSystem({
	update,
	notify,
	unwatched,
}: {
	/**
	 * `sub`, который используется как зависимость, загрязнен и нуждается в перезапуске.
	 * `update` должен перезапустить его и вернуть `true`, если `sub` изменился -- это означает,
	 * что система должна распространить загрязнение к подписчикам `sub`.
	 */
	update(sub: ReactiveNode): boolean;
	/**
	 * Одна из зависимостей `sub` (включая косвенные) могла измениться.
	 * `notify(sub)` должен запланировать проверку загрязненности `sub`, и если так, перезапустить его.
	 */
	notify(sub: ReactiveNode): void;
	/**
	 * У `sub` больше нет подписчиков.
	 * `unwatched(sub)` должен удалить `sub` из его зависимостей и выполнить необходимую очистку,
	 * например, освобождение памяти.
	 */
	unwatched(sub: ReactiveNode): void;
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

	/**
	 * Связывает зависимость с подписчиком.
	 * 
	 * ```ts
	 * const data = signal(1);
	 * const timesTwo = computed(() => data() * 2);
	 * timesTwo();
	 * // link(data, timesTwo);
	 * // data.subs -> timesTwo
	 * // timesTwo.deps -> data
	 * ```
	 */
	function link(dep: ReactiveNode, sub: ReactiveNode): void {
		const prevDep = sub.depsTail;
		if (prevDep !== undefined && prevDep.dep === dep) {
			return;
		}
		let nextDep: Link | undefined = undefined;
		const recursedCheck = sub.flags & ReactiveFlags.RecursedCheck;
		if (recursedCheck) {
			nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps;
			if (nextDep !== undefined && nextDep.dep === dep) {
				sub.depsTail = nextDep;
				return;
			}
		}
		const prevSub = dep.subsTail;
		if (
			prevSub !== undefined
			&& prevSub.sub === sub
			&& (!recursedCheck || isValidLink(prevSub, sub))
		) {
			return;
		}
		const newLink
			= sub.depsTail
			= dep.subsTail
			= {
				dep,
				sub,
				prevDep,
				nextDep,
				prevSub,
				nextSub: undefined,
			};
		if (nextDep !== undefined) {
			nextDep.prevDep = newLink;
		}
		if (prevDep !== undefined) {
			prevDep.nextDep = newLink;
		} else {
			sub.deps = newLink;
		}
		if (prevSub !== undefined) {
			prevSub.nextSub = newLink;
		} else {
			dep.subs = newLink;
		}
	}

	/**
	 * Удаляет связь.
	 * Обновляет начало/конец списка зависимостей в `sub`.
	 * @returns `link.nextDep`, остаток связанного списка.
	 */
	function unlink(link: Link, sub = link.sub): Link | undefined {
		const dep = link.dep;
		const prevDep = link.prevDep;
		const nextDep = link.nextDep;
		const nextSub = link.nextSub;
		const prevSub = link.prevSub;
		if (nextDep !== undefined) {
			nextDep.prevDep = prevDep;
		} else {
			sub.depsTail = prevDep;
		}
		if (prevDep !== undefined) {
			prevDep.nextDep = nextDep;
		} else {
			sub.deps = nextDep;
		}
		if (nextSub !== undefined) {
			nextSub.prevSub = prevSub;
		} else {
			dep.subsTail = prevSub;
		}
		if (prevSub !== undefined) {
			prevSub.nextSub = nextSub;
		} else if ((dep.subs = nextSub) === undefined) {
			unwatched(dep);
		}
		return nextDep;
	}

	/**
	 * Уведомляет всех прямых и косвенных подписчиков узла о том, что они
	 * *могут* быть загрязнены (Pending) и должны быть проверены.
	 */
	function propagate(link: Link): void {
		let next = link.nextSub;
		let stack: Stack<Link | undefined> | undefined;

		// Эта реализация избегает рекурсии, используя явный стек.
		// См. README.md для более понятной рекурсивной версии.
		top: do {
			const sub = link.sub;

			let flags = sub.flags;

			if (flags & (ReactiveFlags.Mutable | ReactiveFlags.Watching)) {
				if (!(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending))) {
					/**
					 * @when Running ❌, Recursed ❌, Dirty ❌
					 * @then Notify ✅, Propagate ✅
					 */
					sub.flags = flags | ReactiveFlags.Pending;
				} else if (!(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed))) {
					/**
					 * @when Running ❌, Recursed ❌, Dirty ✅
					 * @then Notify ❌, Propagate ❌
					 */
					flags = ReactiveFlags.None;
				} else if (!(flags & ReactiveFlags.RecursedCheck)) {
					/**
					 * @when Running ❌, Recursed ✅, Dirty ✅
					 * @then Notify ✅, Propagate ✅
					 */
					sub.flags = (flags & ~ReactiveFlags.Recursed) | ReactiveFlags.Pending;
				} else if (!(flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) && isValidLink(link, sub)) {
					/**
					 * @when Running ✅, Dirty ❌
					 * @then Notify ❌, Propagate ✅
					 */
					sub.flags = flags | ReactiveFlags.Recursed | ReactiveFlags.Pending;
					flags &= ReactiveFlags.Mutable;
				} else {
					/**
					 * @when Running ✅, Dirty ✅
					 * @then Notify ❌, Propagate ❌
					 */
					flags = ReactiveFlags.None;
				}

				if (flags & ReactiveFlags.Watching) {
					notify(sub);
				}

				if (flags & ReactiveFlags.Mutable) {
					const subSubs = sub.subs;
					if (subSubs !== undefined) {
						link = subSubs;
						if (subSubs.nextSub !== undefined) {
							stack = { value: next, prev: stack };
							next = link.nextSub;
						}
						continue;
					}
				}
			}

			if ((link = next!) !== undefined) {
				next = link.nextSub;
				continue;
			}

			while (stack !== undefined) {
				link = stack.value!;
				stack = stack.prev;
				if (link !== undefined) {
					next = link.nextSub;
					continue top;
				}
			}

			break;
		} while (true);
	}

	/**
	 * `startTracking(sub)` подготавливает к перезаписи зависимостей `sub` во время выполнения `sub`.
	 * (Это не изменяет никакого глобального состояния.)
	 * 
	 * Для корректного сбора динамических зависимостей, теоретически мы должны
	 * очистить текущие зависимости при начале отслеживания, чтобы зависимости,
	 * собранные во время повторного выполнения эффекта/вычисления, были новыми и отражали только последний запуск.
	 * 
	 * ```ts
	 * function startTracking(sub: ReactiveNode): void {
	 *   let dep = sub.deps;
	 *   while (dep !== undefined) {
	 *     dep = unlink(dep, sub);
	 *   }
	 *   sub.flags = (sub.flags & ~(ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending)) | ReactiveFlags.RecursedCheck;
	 * }
	 * 
	 * function endTracking(sub: ReactiveNode): void {
	 *   sub.flags &= ~ReactiveFlags.RecursedCheck;
	 * }
	 * ```
	 * 
	 * Но это работает неэффективно. `depsTail = undefined` - это метод оптимизации
	 * для этой проблемы, во время повторного выполнения он будет сравнивать зависимости одну за одной,
	 * чтобы проверить, такие ли они, как раньше. Если да, нужно только обновить depsTail n раз.
	 * Наконец, endTracking обрежет зависимости, которые больше не используются.
	 * (Если зависимости не изменяются, обрезка не требуется.)
	 */
	function startTracking(sub: ReactiveNode): void {
		sub.depsTail = undefined;
		sub.flags = (sub.flags & ~(ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending)) | ReactiveFlags.RecursedCheck;
	}

	/**
	 * `endTracking(sub)` завершает перезапись зависимостей `sub`, обрезая зависимости,
	 * которые не были связаны между предшествующим `startTracking(sub)` и этим вызовом `endTracking(sub)`.
	 */
	function endTracking(sub: ReactiveNode): void {
		const depsTail = sub.depsTail;
		let toRemove = depsTail !== undefined ? depsTail.nextDep : sub.deps;
		while (toRemove !== undefined) {
			toRemove = unlink(toRemove, sub);
		}
		sub.flags &= ~ReactiveFlags.RecursedCheck;
	}

	/**
	 * Проверяет, является ли `sub` загрязненным, то есть зависимости `sub` изменились,
	 * поэтому sub должен перезапуститься.
	 * ```ts
	 * checkDirty(sub.deps!, sub);
	 * ```
	 */
	function checkDirty(link: Link, sub: ReactiveNode): boolean {
		let stack: Stack<Link> | undefined;
		let checkDepth = 0;

		// Эта реализация избегает рекурсии, используя явный стек.
		// См. README.md для более понятной рекурсивной версии.
		top: do {
			const dep = link.dep;
			const depFlags = dep.flags;

			let dirty = false;

			if (sub.flags & ReactiveFlags.Dirty) {
				dirty = true;
			} else if ((depFlags & (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) === (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) {
				if (update(dep)) {
					const subs = dep.subs!;
					if (subs.nextSub !== undefined) {
						shallowPropagate(subs);
					}
					dirty = true;
				}
			} else if ((depFlags & (ReactiveFlags.Mutable | ReactiveFlags.Pending)) === (ReactiveFlags.Mutable | ReactiveFlags.Pending)) {
				if (link.nextSub !== undefined || link.prevSub !== undefined) {
					stack = { value: link, prev: stack };
				}
				link = dep.deps!;
				sub = dep;
				++checkDepth;
				continue;
			}

			if (!dirty && link.nextDep !== undefined) {
				link = link.nextDep;
				continue;
			}

			while (checkDepth) {
				--checkDepth;
				const firstSub = sub.subs!;
				const hasMultipleSubs = firstSub.nextSub !== undefined;
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
						sub = link.sub;
						continue;
					}
				} else {
					sub.flags &= ~ReactiveFlags.Pending;
				}
				sub = link.sub;
				if (link.nextDep !== undefined) {
					link = link.nextDep;
					continue top;
				}
				dirty = false;
			}

			return dirty;
		} while (true);
	}

	/**
	 * Уведомляет прямых подписчиков узла о том, что они загрязнены (Dirty).
	 * Влияет только на узлы подписчиков, уже помеченные как Pending функцией `propagate`.
	 * 
	 * ```ts
	 * if (checkDirty(maybeDirty.deps!, maybeDirty)) {
	 *   if (update(maybeDirty)) {
	 *     maybeDirty.subs && shallowPropagate(maybeDirty.subs);
	 *   }
	 * }
	 * ```
	 */
	function shallowPropagate(link: Link): void {
		do {
			const sub = link.sub;
			const nextSub = link.nextSub;
			const subFlags = sub.flags;
			if ((subFlags & (ReactiveFlags.Pending | ReactiveFlags.Dirty)) === ReactiveFlags.Pending) {
				sub.flags = subFlags | ReactiveFlags.Dirty;
				if (subFlags & ReactiveFlags.Watching) {
					notify(sub);
				}
			}
			link = nextSub!;
		} while (link !== undefined);
	}

	/**
	 * Проверяет, является ли `checkLink` связью в `sub.deps`
	 */
	function isValidLink(checkLink: Link, sub: ReactiveNode): boolean {
		const depsTail = sub.depsTail;
		if (depsTail !== undefined) {
			let link = sub.deps!;
			do {
				if (link === checkLink) {
					return true;
				}
				if (link === depsTail) {
					break;
				}
				link = link.nextDep!;
			} while (link !== undefined);
		}
		return false;
	}
}
