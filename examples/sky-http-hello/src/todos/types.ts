export interface Todo {
  id: number;
  title: string;
  completed: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface TodoCreateInput {
  title: string;
  completed?: boolean;
}

export interface TodoUpdateInput {
  title?: string;
  completed?: boolean;
}
