/**
 * Связанный список для управления зависимостями и подписчиками в реактивной системе.
 * Реализует двусвязный список с отдельными указателями на начало и конец 
 * для зависимостей (dependencies) и подписчиков (subscribers).
 */
export interface LinkedList {
	/** Первый узел в списке зависимостей */
	depHeadNode?: LinkedListNode;
	/** Последний узел в списке зависимостей */
	depTailNode?: LinkedListNode;
	/** Первый узел в списке подписчиков */
	subHeadNode?: LinkedListNode;
	/** Последний узел в списке подписчиков */
	subTailNode?: LinkedListNode;
	/** Флаги состояния реактивного узла */
	flags: ReactiveFlags;
}

/**
 * Узел двусвязного списка, который представляет связь между зависимостью и подписчиком.
 * Каждый узел хранит ссылки на предыдущие и следующие узлы в двух измерениях:
 * - По измерению зависимостей (depList -> dependencies)
 * - По измерению подписчиков (subList -> subscribers)
 */
export interface LinkedListNode {
	/** Список зависимостей, к которому принадлежит этот узел */
	depList: LinkedList;
	/** Список подписчиков, к которому принадлежит этот узел */
	subList: LinkedList;
	/** Предыдущий узел в цепочке подписчиков */
	prevSubNode: LinkedListNode | undefined;
	/** Следующий узел в цепочке подписчиков */
	nextSubNode: LinkedListNode | undefined;
	/** Предыдущий узел в цепочке зависимостей */
	prevDepNode: LinkedListNode | undefined;
	/** Следующий узел в цепочке зависимостей */
	nextDepNode: LinkedListNode | undefined;
}

/**
 * Стек для обхода дерева узлов при распространении изменений.
 * Используется для отслеживания позиций при рекурсивном обходе.
 * @template T Тип значения, хранящегося в стеке
 */
interface Stack<T> {
	/** Значение текущего элемента стека */
	value: T;
	/** Ссылка на предыдущий элемент стека */
	prev: Stack<T> | undefined;
}

/**
 * Флаги состояния реактивных узлов.
 * Используются для оптимизации и контроля процесса обновления реактивной системы.
 */
export enum ReactiveFlags {
	/** Нет активных флагов */
	None = 0,
	/** Узел может изменяться (мутабельный) */
	Mutable = 1 << 0,
	/** Узел находится под наблюдением */
	Watching = 1 << 1,
	/** Выполняется проверка на рекурсию */
	RecursedCheck = 1 << 2,
	/** Обнаружена рекурсия */
	Recursed = 1 << 3,
	/** Узел помечен как "грязный" (требует обновления) */
	Dirty = 1 << 4,
	/** Узел ожидает обработки */
	Pending = 1 << 5,
}

/**
 * Создает реактивную систему для управления зависимостями и их обновлениями.
 * 
 * Реактивная система позволяет автоматически отслеживать зависимости между объектами
 * и распространять изменения от источников к зависимым объектам.
 * 
 * @param config Конфигурация системы
 * @param config.update Функция обновления подписчика. Возвращает true, если обновление произошло
 * @param config.notify Функция уведомления о изменениях
 * @param config.unwatched Функция, вызываемая когда узел больше не наблюдается
 * @returns Объект с методами управления реактивной системой
 */
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

	/**
	 * Создает связь между зависимостью и подписчиком.
	 * 
	 * Устанавливает двунаправленную связь: подписчик будет уведомлен об изменениях зависимости,
	 * а зависимость будет знать о своих подписчиках.
	 * 
	 * @param depList Список зависимостей (источник изменений)
	 * @param subList Список подписчиков (получатель уведомлений)
	 */
	function link(depList: LinkedList, subList: LinkedList): void {
		// Проверяем, есть ли уже связь с этой зависимостью
		const depTailNode = subList.depTailNode;
		if (depTailNode !== undefined && depTailNode.depList === depList) {
			return;
		}
		let nextDepNode: LinkedListNode | undefined = undefined;
		const recursedCheck = subList.flags & 4 satisfies ReactiveFlags.RecursedCheck;
		if (recursedCheck) {
			// При проверке рекурсии ищем следующий узел зависимости
			nextDepNode = depTailNode !== undefined ? depTailNode.nextDepNode : subList.depHeadNode;
			if (nextDepNode !== undefined && nextDepNode.depList === depList) {
				subList.depTailNode = nextDepNode;
				return;
			}
		}
		// Проверяем обратную связь от зависимости к подписчику
		const subTailNode = depList.subTailNode;
		if (
			subTailNode !== undefined
			&& subTailNode.subList === subList
			&& (!recursedCheck || isValidLink(subTailNode, subList))
		) {
			return;
		}
		// Создаем новый узел связи и обновляем указатели в обоих списках
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
		// Обновляем связи в цепочке зависимостей
		if (nextDepNode !== undefined) {
			nextDepNode.prevDepNode = newNode;
		}
		if (depTailNode !== undefined) {
			depTailNode.nextDepNode = newNode;
		} else {
			subList.depHeadNode = newNode;
		}
		// Обновляем связи в цепочке подписчиков
		if (subTailNode !== undefined) {
			subTailNode.nextSubNode = newNode;
		} else {
			depList.subHeadNode = newNode;
		}
	}

	/**
	 * Удаляет связь между зависимостью и подписчиком.
	 * 
	 * Разрывает двунаправленную связь, обновляя все указатели в связанных списках.
	 * Если у зависимости больше нет подписчиков, вызывается callback unwatched.
	 * 
	 * @param link Узел связи для удаления
	 * @param sub Подписчик (по умолчанию берется из узла связи)
	 * @returns Следующий узел зависимости или undefined
	 */
	function unlink(link: LinkedListNode, sub = link.subList): LinkedListNode | undefined {
		const depList = link.depList;
		const prevDepNode = link.prevDepNode;
		const nextDepNode = link.nextDepNode;
		const nextSubNode = link.nextSubNode;
		const prevSubNode = link.prevSubNode;

		// Обновляем цепочку зависимостей
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

		// Обновляем цепочку подписчиков
		if (nextSubNode !== undefined) {
			nextSubNode.prevSubNode = prevSubNode;
		} else {
			depList.subTailNode = prevSubNode;
		}
		if (prevSubNode !== undefined) {
			prevSubNode.nextSubNode = nextSubNode;
		} else if ((depList.subHeadNode = nextSubNode) === undefined) {
			// Если у зависимости больше нет подписчиков, уведомляем об этом
			unwatched(depList);
		}
		return nextDepNode;
	}

	/**
	 * Распространяет изменения от узла ко всем его подписчикам.
	 * 
	 * Выполняет обход дерева подписчиков, используя стек для отслеживания позиций.
	 * Обрабатывает различные флаги состояния и рекурсивно распространяет изменения.
	 * 
	 * @param node Начальный узел для распространения изменений
	 */
	function propagate(node: LinkedListNode): void {
		let nextSubNode = node.nextSubNode;
		let stack: Stack<LinkedListNode | undefined> | undefined;

		top: do {
			const subList = node.subList;

			let flags = subList.flags;

			// Проверяем, нужно ли обрабатывать этот узел
			if (flags & 3 as ReactiveFlags.Mutable | ReactiveFlags.Watching) {
				// Логика обработки флагов состояния
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

				// Уведомляем наблюдателей
				if (flags & 2 satisfies ReactiveFlags.Watching) {
					notify(subList);
				}

				// Рекурсивно обрабатываем подписчиков мутабельных узлов
				if (flags & 1 satisfies ReactiveFlags.Mutable) {
					const subsSubHeadNode = subList.subHeadNode;
					if (subsSubHeadNode !== undefined) {
						node = subsSubHeadNode;
						if (subsSubHeadNode.nextSubNode !== undefined) {
							// Сохраняем текущую позицию в стеке
							stack = { value: nextSubNode, prev: stack };
							nextSubNode = node.nextSubNode;
						}
						continue;
					}
				}
			}

			// Переходим к следующему подписчику
			if ((node = nextSubNode!) !== undefined) {
				nextSubNode = node.nextSubNode;
				continue;
			}

			// Восстанавливаем позицию из стека
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

	/**
	 * Начинает отслеживание зависимостей для подписчика.
	 * 
	 * Подготавливает узел к новому циклу отслеживания, сбрасывая указатель
	 * на последнюю зависимость и устанавливая флаг проверки рекурсии.
	 * 
	 * @param subList Список подписчиков для отслеживания
	 */
	function startTracking(subList: LinkedList): void {
		subList.depTailNode = undefined;
		subList.flags = (subList.flags & ~(56 as ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending)) | 4 satisfies ReactiveFlags.RecursedCheck;
	}

	/**
	 * Завершает отслеживание зависимостей для подписчика.
	 * 
	 * Удаляет все зависимости, которые больше не используются в текущем цикле.
	 * Это происходит путем удаления всех узлов после depTailNode.
	 * 
	 * @param subList Список подписчиков для завершения отслеживания
	 */
	function endTracking(subList: LinkedList): void {
		const depTailNode = subList.depTailNode;
		// Удаляем все неиспользуемые зависимости
		let toRemove = depTailNode !== undefined ? depTailNode.nextDepNode : subList.depHeadNode;
		while (toRemove !== undefined) {
			toRemove = unlink(toRemove, subList);
		}
		subList.flags &= ~(4 satisfies ReactiveFlags.RecursedCheck);
	}

	/**
	 * Проверяет, нужно ли обновить узел, и выполняет обновление если необходимо.
	 * 
	 * Рекурсивно проверяет цепочку зависимостей, определяя какие узлы нуждаются в обновлении.
	 * Использует стек для отслеживания глубины проверки и избегания повторных вычислений.
	 * 
	 * @param node Узел для проверки
	 * @param subList Список подписчиков
	 * @returns true если узел был обновлен и стал "грязным"
	 */
	function checkDirty(node: LinkedListNode, subList: LinkedList): boolean {
		let stack: Stack<LinkedListNode> | undefined;
		let checkDepth = 0;

		top: do {
			const depList = node.depList;
			const depFlags = depList.flags;
			let dirty = false;

			// Определяем, является ли узел "грязным"
			if (subList.flags & 16 satisfies ReactiveFlags.Dirty) {
				dirty = true;
			} else if ((depFlags & 17 as ReactiveFlags.Mutable | ReactiveFlags.Dirty) === 17 as ReactiveFlags.Mutable | ReactiveFlags.Dirty) {
				// Обновляем мутабельный "грязный" узел
				if (update(depList)) {
					const subs = depList.subHeadNode!;
					if (subs.nextSubNode !== undefined) {
						shallowPropagate(subs);
					}
					dirty = true;
				}
			} else if ((depFlags & 33 as ReactiveFlags.Mutable | ReactiveFlags.Pending) === 33 as ReactiveFlags.Mutable | ReactiveFlags.Pending) {
				// Рекурсивно проверяем зависимости
				if (node.nextSubNode !== undefined || node.prevSubNode !== undefined) {
					stack = { value: node, prev: stack };
				}
				node = depList.depHeadNode!;
				subList = depList;
				++checkDepth;
				continue;
			}

			// Переходим к следующей зависимости если текущая не "грязная"
			if (!dirty && node.nextDepNode !== undefined) {
				node = node.nextDepNode;
				continue;
			}

			// Возвращаемся по стеку проверки
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
					// Сбрасываем флаг ожидания если узел не грязный
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

	/**
	 * Выполняет поверхностное распространение изменений по цепочке подписчиков.
	 * 
	 * Проходит по всем подписчикам начиная с указанного узла и помечает их как "грязные"
	 * если они находятся в состоянии ожидания. Уведомляет наблюдателей о изменениях.
	 * 
	 * @param node Начальный узел для распространения
	 */
	function shallowPropagate(node: LinkedListNode): void {
		do {
			const subList = node.subList;
			const nextSubNode = node.nextSubNode;
			const subListFlags = subList.flags;
			// Помечаем как "грязный" если узел ожидает обработки
			if ((subListFlags & 48 as ReactiveFlags.Pending | ReactiveFlags.Dirty) === 32 satisfies ReactiveFlags.Pending) {
				subList.flags = subListFlags | 16 satisfies ReactiveFlags.Dirty;
				if (subListFlags & 2 satisfies ReactiveFlags.Watching) {
					notify(subList);
				}
			}
			node = nextSubNode!;
		} while (node !== undefined);
	}

	/**
	 * Проверяет, является ли связь действительной в текущем контексте отслеживания.
	 * 
	 * Ищет указанный узел в цепочке зависимостей от начала до depTailNode.
	 * Используется для валидации связей при проверке рекурсии.
	 * 
	 * @param checkNode Узел для проверки
	 * @param subList Список подписчиков для поиска
	 * @returns true если связь действительна
	 */
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
